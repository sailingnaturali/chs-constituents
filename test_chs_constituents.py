"""Self-checks. Run with `python test_chs_constituents.py` (or pytest).

Deliberately small: these cover the logic that is easy to get silently wrong --
chunk-grid alignment, event extraction, and flip detection. Everything else is
either a thin API wrapper or utide's problem.
"""

import datetime as dt

import numpy as np

import chs_constituents as cc


def test_chunk_grid_is_shared_across_window_lengths():
    """A short training window must reuse the long window's cached chunks.

    This is the whole reason chunks are anchored to a fixed epoch grid rather
    than to the caller's start date. If it regresses, changing --training-days
    silently refetches everything against a rate limit.
    """
    start = dt.datetime(2025, 7, 1, tzinfo=dt.timezone.utc)

    def grid(days):
        out, chunk = [], cc._floor_to_grid(start)
        end = start + dt.timedelta(days=days)
        while chunk < end:
            out.append(chunk)
            chunk += dt.timedelta(days=cc.CHUNK_DAYS)
        return out

    short, long = grid(60), grid(180)
    assert short == long[:len(short)], "60-day chunks must be a prefix of 180-day chunks"
    assert cc._floor_to_grid(start) <= start
    assert (cc._floor_to_grid(start) - cc.EPOCH).days % cc.CHUNK_DAYS == 0


def test_predict_events_finds_slacks_and_extrema():
    """A clean sinusoid must yield alternating slack / extremum events."""
    start = dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=2)

    class FakeSolution:
        pass

    period_min = 745.0  # M2, near enough
    minutes = int((end - start).total_seconds() // 60)
    signal = 3.0 * np.sin(2 * np.pi * np.arange(minutes) / period_min)

    original = cc.utide.reconstruct
    cc.utide.reconstruct = lambda *a, **k: type("R", (), {"h": signal})()
    try:
        events = cc.predict_events(FakeSolution(), start, end)
    finally:
        cc.utide.reconstruct = original

    kinds = [e["kind"] for e in events]
    assert "slack" in kinds and "maxFlood" in kinds and "maxEbb" in kinds
    # A semidiurnal current slacks 4x/day (2 floods + 2 ebbs), so ~8 over 2 days.
    assert 7 <= kinds.count("slack") <= 9, f"unexpected slack count: {kinds.count('slack')}"
    peaks = [e["speed"] for e in events if e["kind"] == "maxFlood"]
    assert all(abs(p - 3.0) < 0.1 for p in peaks), f"peak amplitude wrong: {peaks}"


def test_flip_detection_uses_sign_not_nearest_event():
    """A reversed axis must quarantine -- and bad TIMING alone must not.

    Regression guard. The first implementation compared each CHS event to the
    nearest predicted event of any kind, so a station running late paired a CHS
    ebb with our flood and was reported as flipped. That false-quarantined three
    stations that the sign test showed were directionally perfect.
    """
    start = dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    observed = [
        {"time": "2026-06-01T02:00:00Z", "kind": "maxFlood", "speed": 3.0},
        {"time": "2026-06-01T08:00:00Z", "kind": "maxEbb", "speed": -3.0},
    ]

    def run(sign):
        # sign=+1 models the same direction CHS reports; -1 models it reversed.
        station = {"_solution": None}
        orig_recon, orig_pred = cc.utide.reconstruct, cc.predict_events
        cc.utide.reconstruct = lambda t, *a, **k: type(
            "R", (), {"h": np.array([sign * 3.0, sign * -3.0])})()
        # Timing is identical in both runs (3 min late) so that DIRECTION is the
        # only variable between them.
        cc.predict_events = lambda *a, **k: [
            {"minute": 123, "kind": "maxFlood", "speed": 3.0},
            {"minute": 483, "kind": "maxEbb", "speed": -3.0},
        ]
        try:
            return cc.validate(station, observed, start, end)
        finally:
            cc.utide.reconstruct, cc.predict_events = orig_recon, orig_pred

    aligned = run(+1)
    assert aligned["wrongSign"] == 0, aligned
    assert cc.tier(aligned) == "high", "good timing + correct direction should be high"

    reversed_axis = run(-1)
    # Same timing, same median -- only the modelled direction is reversed.
    assert reversed_axis["median"] == aligned["median"]
    assert reversed_axis["wrongSign"] == 2, reversed_axis
    assert cc.tier(reversed_axis) == "quarantine", "reversed axis must outrank good timing"


def test_tier_thresholds():
    clean = {"wrongSign": 0, "extrema": 20}
    assert cc.tier({"median": 1.2, **clean}) == "high"
    assert cc.tier({"median": 15.0, **clean}) == "medium"
    assert cc.tier({"median": 30.0, **clean}) == "low"
    assert cc.tier({"median": 50.0, **clean}) == "quarantine"
    # A reversed axis outranks a good median: the crew acts on direction. Note
    # the fraction -- a truly reversed axis is wrong at nearly every extremum,
    # because the error is systematic rather than occasional.
    assert cc.tier({"median": 1.0, "wrongSign": 19, "extrema": 20}) == "quarantine"
    # Half wrong is not a reversed axis; that is a station in trouble some other
    # way, and the timing tiers should be the ones to judge it.
    assert cc.tier({"median": 1.0, "wrongSign": 10, "extrema": 20}) == "high"
    # Partial sign disagreement is timing error, not a reversed axis. Juan de
    # Fuca East sits here: 7/27 wrong sign with a correct, documented 090 flood
    # axis, at a weak slow-reversing station -- ~17 min on extrema, ~83 min on
    # slacks (the wrong-side-of-zero windows are what flip the occasional sign).
    assert cc.tier({"median": 10.0, "wrongSign": 7, "extrema": 27}) == "medium"
    # And a genuinely bad extremum median still quarantines on timing alone.
    assert cc.tier({"median": 39.0, "wrongSign": 7, "extrema": 27}) == "quarantine", \
        "should quarantine on TIMING, not on a false reversed-axis claim"


def test_validation_separates_slack_timing_from_extremum_timing():
    """Slack timing must not pollute the headline median.

    Root cause of the three-harness divergence (audit Q2): at a weak,
    slow-reversing station (Juan de Fuca East), slack events carry ~83 min
    error while extrema sit near 17. Pooling them yielded a 39-min median no
    other harness could reproduce -- the other two measure extrema only. The
    headline median (and therefore the tier) is extrema-only; slack error is
    real information about a weak station, so it is reported separately, not
    discarded.
    """
    start = dt.datetime(2026, 6, 1, tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    observed = [
        {"time": "2026-06-01T02:03:00Z", "kind": "maxFlood", "speed": 3.0},
        {"time": "2026-06-01T08:03:00Z", "kind": "maxEbb", "speed": -3.0},
        {"time": "2026-06-01T05:20:00Z", "kind": "slack", "speed": 0.0},
        {"time": "2026-06-01T11:20:00Z", "kind": "slack", "speed": 0.0},
    ]

    station = {"_solution": None}
    orig_recon, orig_pred = cc.utide.reconstruct, cc.predict_events
    cc.utide.reconstruct = lambda t, *a, **k: type("R", (), {"h": np.array([3.0, -3.0])})()
    # Extrema predicted 3 min early; slacks predicted 80 min early.
    cc.predict_events = lambda *a, **k: [
        {"minute": 120, "kind": "maxFlood", "speed": 3.0},
        {"minute": 480, "kind": "maxEbb", "speed": -3.0},
        {"minute": 240, "kind": "slack", "speed": 0.0},
        {"minute": 600, "kind": "slack", "speed": 0.0},
    ]
    try:
        result = cc.validate(station, observed, start, end)
    finally:
        cc.utide.reconstruct, cc.predict_events = orig_recon, orig_pred

    assert result["median"] == 3.0, f"headline median must be extrema-only: {result}"
    assert result["slackMedian"] == 80.0, f"slack error must be reported apart: {result}"
    assert cc.tier(result) == "high", "tier must judge extremum timing, not slack timing"


def test_best_candidate_prefers_lower_median_and_primary_on_tie():
    """Per-gate window selection: lowest extremum median wins.

    Neither training window dominates (180d wins Second Narrows by 9.5 min,
    60d wins Gabriola by 15), so the pipeline fits both and keeps the better
    per gate. A missing median loses to any measured one; a tie keeps the
    primary (first) candidate so the default window is stable.
    """
    assert cc.best_candidate([{"median": 5.0}, {"median": 3.0}]) == 1
    assert cc.best_candidate([{"median": 3.0}, {"median": 5.0}]) == 0
    assert cc.best_candidate([{"median": 3.0}, {"median": 3.0}]) == 0
    assert cc.best_candidate([{"median": None}, {"median": 40.0}]) == 1
    assert cc.best_candidate([{"median": None}]) == 0


def test_bundle_carries_validation_provenance():
    """A validated bundle must say who validated it and against what.

    The hand-maintained predecessor (infrastructure ca-currents.json) carried
    tiers with no record of which harness produced them, and drifted. The
    pipeline is the sole producer now, so every regenerated bundle must carry
    its own attribution -- otherwise regeneration silently erases provenance.
    """
    stations = [{"id": "chs-x", "name": "X", "type": "harmonic", "confidence": "high"}]

    validated = cc.assemble_bundle(stations, 180, "2025-07-01",
                                   validate_from="2026-06-01", validate_days=7)
    assert "chs-constituents" in validated["validationSource"], validated
    assert "2026-06-01" in validated["validationSource"]
    assert validated["validationNote"]
    assert validated["stations"] == stations
    assert validated["trainingDays"] == 180

    unvalidated = cc.assemble_bundle(stations, 180, "2025-07-01",
                                     validate_from=None, validate_days=7)
    assert "validationSource" not in unvalidated
    assert "validationNote" not in unvalidated


def test_harmonic_roundtrip_recovers_known_amplitude():
    """End-to-end sanity on utide itself, including the epoch convention.

    Guards the epoch='1970-01-01' requirement: with the wrong epoch this fit
    still 'succeeds' but returns collapsed amplitudes.
    """
    days = 45
    samples = days * 96  # wcsp1 is 15-minute sampled
    t = np.arange(samples) / 96.0 + (dt.datetime(2025, 7, 1) - dt.datetime(1970, 1, 1)).days
    m2_period_days = 12.4206012 / 24.0
    signal = 2.5 * np.cos(2 * np.pi * t / m2_period_days)

    solution = cc.utide.solve(
        t, signal, lat=49.0, constit=["M2", "S2", "K1", "O1"],
        conf_int="none", method="ols", epoch="1970-01-01", verbose=False,
    )
    amplitudes = dict(zip(solution.name, solution.A))
    assert abs(amplitudes["M2"] - 2.5) < 0.15, f"M2 not recovered: {amplitudes}"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
