"""Fit tidal-current harmonic constituents from CHS IWLS predictions.

You run this yourself, for your own boat. See README.md for why that is not
merely a suggestion: CHS licence clause 3 forbids passing their data (or data
transferred from it) to a third party, so nobody can hand you a finished bundle.
Clause 10 permits you to derive one for your own non-commercial use.

Pipeline, per station:
  1. fetch wcsp1 (speed) + wcdp1 (direction) continuous predictions
  2. project onto the flood axis -> signed along-channel velocity
  3. harmonic analysis (utide)
  4. optionally validate against wcp1-events out-of-sample, and tier by accuracy
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import utide

API = "https://api-sine.dfo-mpo.gc.ca/api/v1"

# IWLS documents 3 requests/sec and 30/min. We pace to the *minute* limit, which
# is the binding one for bulk fetches. The original research script used 1.1s
# (~54/min) and was not throttled, but a tool many boats run should stay inside
# the published limit -- one impatient client getting the whole tool blocked is
# a bad trade. Override with --request-interval if you know what you are doing.
DEFAULT_REQUEST_INTERVAL = 2.0

# IWLS caps a single data request at 7 days.
CHUNK_DAYS = 7

# Constituents to solve for. The shallow-water terms (M4, MS4, MN4, M6) matter
# a great deal at constricted passes -- that is where the nonlinear advection and
# quadratic friction that generate them actually live. Dropping them costs real
# accuracy at exactly the gates you most want to time.
CONSTITUENTS = [
    "M2", "S2", "N2", "K2", "K1", "O1", "P1", "Q1",
    "M4", "MS4", "MN4", "2N2", "MU2", "NU2", "L2", "T2",
    "J1", "MM", "MSF", "MF", "M6", "S4", "M3",
]

# CHS event qualifiers -> our event kinds.
QUALIFIER = {"SLACK": "slack", "EXTREMA_FLOOD": "maxFlood", "EXTREMA_EBB": "maxEbb"}

# Median event-timing error (minutes) -> confidence tier. Thresholds follow the
# empirical spread seen across Salish Sea gates: clean reversing passes land
# near 1 min, complex narrows near 20, violent rapids near 30.
TIERS = ((5.0, "high"), (20.0, "medium"), (35.0, "low"))

EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


# --------------------------------------------------------------------------
# IWLS client
# --------------------------------------------------------------------------

class Client:
    """Rate-limited IWLS client with on-disk chunk caching."""

    def __init__(self, cache_dir: pathlib.Path, interval: float, user_agent: str):
        self.cache_dir = cache_dir
        self.interval = interval
        self.headers = {"User-Agent": user_agent}
        self._last = 0.0
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _wait(self) -> None:
        gap = time.monotonic() - self._last
        if gap < self.interval:
            time.sleep(self.interval - gap)
        self._last = time.monotonic()

    def get(self, path: str, attempts: int = 5):
        url = f"{API}/{path}"
        delay = self.interval
        for attempt in range(attempts):
            self._wait()
            try:
                req = urllib.request.Request(url, headers=self.headers)
                with urllib.request.urlopen(req, timeout=45) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    # Backoff on throttling rather than hammering; IWLS will keep
                    # saying no otherwise and the whole run dies late.
                    delay = min(delay * 2, 60.0)
                    print(f"  429 throttled, backing off {delay:.0f}s", file=sys.stderr)
                    time.sleep(delay)
                    continue
                if exc.code < 500 or attempt == attempts - 1:
                    raise
                time.sleep(delay)
            except Exception:
                if attempt == attempts - 1:
                    raise
                time.sleep(delay)
        raise RuntimeError(f"fetch failed after {attempts} attempts: {url}")

    def series(self, station_id: str, code: str, start: dt.datetime, days: int) -> dict:
        """Fetch a continuous time series, chunked and cached.

        Chunks are anchored to a fixed global 7-day grid rather than to `start`,
        so a 60-day run and a 180-day run share cache entries exactly. Without
        that, changing the training window silently refetches everything.
        """
        end = start + dt.timedelta(days=days)
        out: dict[str, float] = {}
        chunk = _floor_to_grid(start)
        while chunk < end:
            nxt = chunk + dt.timedelta(days=CHUNK_DAYS)
            out.update(self._chunk(station_id, code, chunk))
            chunk = nxt
        return {t: v for t, v in out.items() if start <= _parse(t) < end}

    def _chunk(self, station_id: str, code: str, chunk_start: dt.datetime) -> dict:
        key = f"{station_id}-{code}-{chunk_start:%Y%m%d}.json"
        path = self.cache_dir / key
        if path.exists():
            return json.loads(path.read_text())
        chunk_end = chunk_start + dt.timedelta(days=CHUNK_DAYS)
        rows = self.get(
            f"stations/{station_id}/data?time-series-code={code}"
            f"&from={_iso(chunk_start)}&to={_iso(chunk_end)}"
        )
        data = {row["eventDate"]: row["value"] for row in rows}
        path.write_text(json.dumps(data))
        return data


def _floor_to_grid(when: dt.datetime) -> dt.datetime:
    """Snap to the fixed 7-day grid measured from the Unix epoch."""
    days = (when - EPOCH).days
    return EPOCH + dt.timedelta(days=days - (days % CHUNK_DAYS))


def _iso(when: dt.datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(stamp: str) -> dt.datetime:
    return dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def _days_since_epoch(stamps) -> np.ndarray:
    return np.array([(_parse(s) - EPOCH).total_seconds() / 86400.0 for s in stamps])


# --------------------------------------------------------------------------
# Fit
# --------------------------------------------------------------------------

def fit_station(client: Client, station: dict, start: dt.datetime, days: int,
                min_amplitude: float = 0.003) -> dict | None:
    """Fetch, project onto the flood axis, and solve for constituents."""
    station_id = station["id"]
    meta = client.get(f"stations/{station_id}/metadata")
    flood = meta["floodDirection"]
    ebb = meta["ebbDirection"]
    lat = meta.get("latitude", 49.0)

    speed = client.series(station_id, "wcsp1", start, days)
    direction = client.series(station_id, "wcdp1", start, days)
    stamps = sorted(set(speed) & set(direction))

    # wcsp1 is 15-minute sampled, so ~96 samples/day. Refuse to fit a series too
    # short to separate the constituents we are asking for.
    minimum = int(days * 96 * 0.6)
    if len(stamps) < minimum:
        print(f"  SKIP: only {len(stamps)} samples (need {minimum})", file=sys.stderr)
        return None

    tnum = _days_since_epoch(stamps)
    # Projection onto the flood axis. This is linear, so it is equivalent to a
    # full 2D fit projected onto the same axis -- verified against a 2D solve.
    velocity = np.array([speed[t] * math.cos(math.radians(direction[t] - flood)) for t in stamps])

    solution = utide.solve(
        tnum, velocity,
        lat=lat,
        constit=CONSTITUENTS,
        conf_int="none",
        method="ols",
        # CRITICAL: utide interprets `tnum` relative to this epoch. Any other
        # value here silently collapses every frequency -- the fit "succeeds"
        # and the output is garbage. This cost real debugging time.
        epoch="1970-01-01",
        verbose=False,
    )

    constituents = [
        {
            "name": solution.name[i],
            "amplitude": round(float(solution.A[i]), 4),
            "phase": round(float(solution.g[i]), 2),
        }
        for i in range(len(solution.name))
        if solution.A[i] > min_amplitude
    ]

    reconstructed = utide.reconstruct(tnum, solution, epoch="1970-01-01", verbose=False)
    rms = float(np.sqrt(np.mean((velocity - reconstructed.h) ** 2)))

    print(f"  {len(constituents)} constituents, RMS {rms:.3f} kn, "
          f"peak ~{np.ptp(velocity) / 2:.1f} kn", file=sys.stderr)

    return {
        "id": "chs-" + re.sub(r"[^a-z0-9]+", "-", station["label"].lower()).strip("-"),
        "name": station["label"],
        "type": "harmonic",
        "source": "chs-derived",
        "floodDirection": flood,
        "ebbDirection": ebb,
        "offset": round(float(solution.mean), 4),
        "constituents": constituents,
        "_solution": solution,
        "_lat": lat,
    }


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def predict_events(solution, start: dt.datetime, end: dt.datetime) -> list[dict]:
    """Reconstruct at 1-minute resolution and extract slacks and extrema."""
    minutes = int((end - start).total_seconds() // 60)
    tnum = np.array([((start - EPOCH).total_seconds() / 86400.0) + m / 1440.0
                     for m in range(minutes)])
    velocity = utide.reconstruct(tnum, solution, epoch="1970-01-01", verbose=False).h

    events = []
    sign = np.sign(velocity)
    crossings = np.where(np.diff(sign) != 0)[0]
    for idx in crossings:
        events.append({"minute": int(idx), "kind": "slack", "speed": 0.0})

    # Between consecutive slacks, the single extreme value is the max flood or ebb.
    bounds = [0, *crossings.tolist(), minutes - 1]
    for lo, hi in zip(bounds, bounds[1:]):
        if hi - lo < 2:
            continue
        segment = velocity[lo:hi]
        idx = int(np.argmax(np.abs(segment)))
        peak = float(segment[idx])
        events.append({
            "minute": lo + idx,
            "kind": "maxFlood" if peak > 0 else "maxEbb",
            "speed": peak,
        })
    return sorted(events, key=lambda e: e["minute"])


# A same-kind event more than this far from its counterpart is not a match, it is
# a different tidal cycle. Without the cap, a badly-timed station scores well by
# accidentally pairing with the next cycle's event.
MATCH_WINDOW_MIN = 180.0

# Fraction of extrema with the wrong sign above which the flood axis is judged
# reversed. Deliberately high: a genuinely reversed axis disagrees at nearly
# EVERY extremum, because the error is systematic. Partial disagreement means
# something else -- usually timing error at a weak, slow-reversing station, where
# a large slack error spends long windows on the wrong side of zero. Juan de
# Fuca East was false-quarantined at 0.20 (7/27 = 26%) when its axis is correct
# and documented; its real character is ~17 min extremum timing with ~83 min
# slack timing, which the split median/slackMedian stats now show honestly.
FLIP_QUARANTINE = 0.60


def validate(station: dict, observed: list[dict], start: dt.datetime, end: dt.datetime,
             significant: float = 0.75) -> dict:
    """Compare predicted events against CHS's own wcp1-events, out of sample.

    Three independent measures, deliberately kept apart:

    * TIMING -- distance to the nearest predicted event *of the same kind*,
      extrema only. This is the headline median and what the tier judges; it is
      also the definition the other harnesses measure, so numbers compare. Max
      is inflated by CHS's own continuous-vs-event disagreement (15-30 min at
      complex narrows), a property of the source data rather than of this fit.

    * SLACK TIMING -- same matching, slack events only, reported as slackMedian.
      Never pooled into the headline: at weak, slow-reversing stations the zero
      crossing is hypersensitive to small level errors (Juan de Fuca East:
      ~17 min extrema, ~83 min slacks), and pooling once produced a 39-min
      "median" no extrema-only harness could reproduce.

    * DIRECTION -- the sign of the modelled velocity at the exact moment CHS
      reports maximum flood or ebb. This is the only sound flip test. An earlier
      version compared against the nearest predicted event of *any* kind, which
      conflates bad timing with a reversed axis: at a station running 40 minutes
      late, the nearest event to a CHS ebb is often our flood, and it was
      reported as a flip. That false-quarantined three good stations.
    """
    predicted = predict_events(station["_solution"], start, end)
    if not predicted:
        return {"median": None, "max": None, "slackMedian": None,
                "wrongSign": 0, "extrema": 0, "matched": 0}

    # Slack timing is kept apart from extremum timing. At a weak, slow-reversing
    # station the zero crossing is hypersensitive to small level errors: Juan de
    # Fuca East runs ~17 min on extrema but ~83 min on slacks, and pooling them
    # produced a 39-min median that no extrema-only harness could reproduce.
    # The headline median -- and the tier -- judge extrema; slack error is real
    # information about how trustworthy the slack window is, reported separately.
    deltas: list[float] = []
    slack_deltas: list[float] = []
    for event in observed:
        # Slacks always count; extrema only when the current is actually running.
        if event["kind"] != "slack" and abs(event["speed"]) < significant:
            continue
        when = (_parse(event["time"]) - start).total_seconds() / 60.0
        same_kind = [p for p in predicted if p["kind"] == event["kind"]]
        if not same_kind:
            continue
        best = min(same_kind, key=lambda p: abs(p["minute"] - when))
        delta = abs(best["minute"] - when)
        if delta <= MATCH_WINDOW_MIN:
            (slack_deltas if event["kind"] == "slack" else deltas).append(delta)

    extrema = [e for e in observed if e["kind"] in ("maxFlood", "maxEbb")]
    wrong_sign = 0
    if extrema:
        tnum = np.array([(_parse(e["time"]) - EPOCH).total_seconds() / 86400.0 for e in extrema])
        modelled = utide.reconstruct(tnum, station["_solution"],
                                     epoch="1970-01-01", verbose=False).h
        wrong_sign = sum(
            1 for value, event in zip(modelled, extrema)
            if (event["kind"] == "maxFlood" and value < 0)
            or (event["kind"] == "maxEbb" and value > 0)
        )

    return {
        "median": round(float(np.median(deltas)), 1) if deltas else None,
        "max": round(float(np.max(deltas)), 1) if deltas else None,
        "slackMedian": round(float(np.median(slack_deltas)), 1) if slack_deltas else None,
        "wrongSign": int(wrong_sign),
        "extrema": len(extrema),
        "matched": len(deltas) + len(slack_deltas),
    }


def tier(result: dict) -> str:
    """Assign a confidence tier.

    A reversed axis outranks good timing: a current predicted backwards is worse
    than one predicted late, because the crew acts on direction.
    """
    if result["median"] is None:
        return "quarantine"
    if result["extrema"] and result["wrongSign"] / result["extrema"] >= FLIP_QUARANTINE:
        return "quarantine"
    for threshold, name in TIERS:
        if result["median"] <= threshold:
            return name
    return "quarantine"


def assemble_bundle(stations: list[dict], training_days: int, training_start: str,
                    validate_from: str | None, validate_days: int) -> dict:
    """Build the output bundle, carrying its own validation provenance.

    The tiers travel with a record of who produced them and against which golden
    window; without that, a regenerated bundle silently sheds the basis for its
    own confidence fields (which is exactly how the hand-maintained predecessor
    drifted).
    """
    out = {
        "note": ("Derived from CHS IWLS predictions for personal, non-commercial use. "
                 "Contains Canadian Hydrographic Service intellectual property; Crown "
                 "copyright is retained by His Majesty the King in Right of Canada. "
                 "NOT FOR NAVIGATION. Do not redistribute -- see README.md."),
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "trainingDays": training_days,
        "trainingStart": training_start,
    }
    if validate_from:
        out["validationSource"] = (
            f"chs-constituents (automated), {out['generated']}, "
            f"out-of-sample {validate_from}+{validate_days}d vs CHS wcp1-events"
        )
        out["validationNote"] = (
            "validationMedianMin is the median abs timing error over CHS extrema "
            f"only, vs the nearest same-kind predicted event (cap {MATCH_WINDOW_MIN:.0f} "
            "min); slack timing is validationSlackMedianMin, never pooled into the "
            "headline. Direction tested as the sign of modelled velocity at CHS "
            "extremum times. Tiers judge extremum timing."
        )
    out["stations"] = stations
    return out


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Fit tidal-current harmonic constituents from CHS IWLS predictions.",
        epilog="You must run this yourself; the output cannot be redistributed. See README.md.",
    )
    parser.add_argument("--stations", default="stations/salish-sea.json",
                        help="JSON list of {id, label} CHS current stations.")
    parser.add_argument("--output", default="currents.json", help="Output bundle path.")
    parser.add_argument("--training-days", type=int, default=180,
                        help="Length of the training series (default: 180).")
    parser.add_argument("--training-start", default="2025-07-01",
                        help="UTC date the training series starts (YYYY-MM-DD).")
    parser.add_argument("--validate-from", default=None,
                        help="UTC date to begin out-of-sample validation (YYYY-MM-DD). "
                             "Omit to skip validation and confidence tiering.")
    parser.add_argument("--validate-days", type=int, default=7,
                        help="Length of the validation window (default: 7).")
    parser.add_argument("--cache-dir", default=".cache",
                        help="Where to cache fetched chunks (default: .cache).")
    parser.add_argument("--request-interval", type=float, default=DEFAULT_REQUEST_INTERVAL,
                        help=f"Seconds between requests (default: {DEFAULT_REQUEST_INTERVAL}).")
    parser.add_argument("--user-agent", default="chs-constituents/1.0",
                        help="User-Agent to send.")
    parser.add_argument("--only", action="append", default=None,
                        help="Only fit stations whose label contains this (repeatable).")
    args = parser.parse_args(argv)

    stations = json.loads(pathlib.Path(args.stations).read_text())
    if args.only:
        wanted = [s.lower() for s in args.only]
        stations = [s for s in stations if any(w in s["label"].lower() for w in wanted)]
        if not stations:
            print("No stations matched --only", file=sys.stderr)
            return 1

    start = dt.datetime.strptime(args.training_start, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    client = Client(pathlib.Path(args.cache_dir), args.request_interval, args.user_agent)

    val_start = val_end = None
    if args.validate_from:
        val_start = dt.datetime.strptime(args.validate_from, "%Y-%m-%d").replace(
            tzinfo=dt.timezone.utc)
        val_end = val_start + dt.timedelta(days=args.validate_days)

    estimate = len(stations) * (args.training_days / CHUNK_DAYS) * 2 * args.request_interval / 60
    print(f"{len(stations)} station(s), {args.training_days}d training "
          f"-- roughly {estimate:.0f} min of fetching (cached chunks are free)\n",
          file=sys.stderr)

    bundle = []
    for station in stations:
        print(f"{station['label']}:", file=sys.stderr)
        try:
            fitted = fit_station(client, station, start, args.training_days)
        except Exception as exc:  # one bad station must not lose the whole run
            print(f"  FAILED: {exc}", file=sys.stderr)
            continue
        if fitted is None:
            continue

        if val_start:
            rows = client.get(
                f"stations/{station['id']}/data?time-series-code=wcp1-events"
                f"&from={_iso(val_start)}&to={_iso(val_end)}"
            )
            observed = [
                {
                    "time": r["eventDate"],
                    "kind": QUALIFIER[r["qualifier"]],
                    "speed": (0.0 if r["qualifier"] == "SLACK"
                              else r["value"] if r["qualifier"] == "EXTREMA_FLOOD"
                              else -r["value"]),
                }
                for r in rows if r["qualifier"] in QUALIFIER
            ]
            result = validate(fitted, observed, val_start, val_end)
            fitted["confidence"] = tier(result)
            fitted["validationMedianMin"] = result["median"]
            fitted["validationSlackMedianMin"] = result["slackMedian"]
            reversed_pct = (100 * result["wrongSign"] / result["extrema"]) if result["extrema"] else 0
            flag = (f"  <-- REVERSED AXIS ({result['wrongSign']}/{result['extrema']} extrema)"
                    if reversed_pct >= 100 * FLIP_QUARANTINE else
                    f"  ({result['wrongSign']}/{result['extrema']} wrong sign)"
                    if result["wrongSign"] else "")
            print(f"  validated: median {result['median']} min (slacks {result['slackMedian']}), "
                  f"max {result['max']} min, {result['matched']} events, "
                  f"tier {fitted['confidence']}{flag}",
                  file=sys.stderr)

        bundle.append({k: v for k, v in fitted.items() if not k.startswith("_")})

    pathlib.Path(args.output).write_text(json.dumps(assemble_bundle(
        bundle, args.training_days, args.training_start,
        args.validate_from, args.validate_days,
    ), indent=1))

    quarantined = [s["name"] for s in bundle if s.get("confidence") == "quarantine"]
    print(f"\nwrote {args.output} ({len(bundle)} stations)", file=sys.stderr)
    if quarantined:
        print(f"QUARANTINED (do not use): {', '.join(quarantined)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
