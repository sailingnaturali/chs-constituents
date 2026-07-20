# chs-constituents

Fit tidal-current harmonic constituents from Canadian Hydrographic Service predictions, so
your chartplotter, SignalK server, or app can predict currents **offline**.

You run this yourself, for your own boat. That is not a stylistic choice — see
[Why you have to run this yourself](#why-you-have-to-run-this-yourself).

```sh
npm install
npm run fit -- --only "Active Pass" --validate-from 2026-06-01
```

---

## Why you have to run this yourself

In US waters this problem does not exist. NOAA publishes tidal-current harmonic constituents
as public-domain data; anyone can bundle them into anything, commercial or not, and offline
current prediction just works.

Canada does not do this. The [CHS licence agreement](https://tides.gc.ca/en/licence-agreement)
you accept by using the IWLS API is a bespoke Crown licence, not the
[Open Government Licence](https://open.canada.ca/en/open-government-licence-canada). Three
clauses matter:

- **Clause 3** — CHS copyrights "shall not be sold, licensed, leased, assigned or given to a
  third party."
- **Clause 4** — prohibits derivative products "for commercial purposes, for sale or profit
  under any form whatsoever."
- **Clause 10** — **permits non-profit derivative products**, provided you carry a prominent
  notice: your name, acknowledgment that the product contains CHS intellectual property, that
  Crown copyright is retained, that it is not to be used for navigation, and that CHS does not
  endorse it.

So clause 10 lets *you* derive constituents for your own non-commercial use, and clause 3
stops anyone from handing you a finished bundle. Hence a pipeline instead of a dataset. **This
repository contains no CHS-derived data and never will.** Running it produces data on your
machine that is yours to use and not yours to redistribute.

If that seems like a lot of ceremony to predict when the tide turns at Dodd Narrows: yes.

### This isn't hypothetical

XTide shipped Canadian harmonic constants with explicit non-commercial notices attached.
Debian packaged them separately as `xtide-data-nonfree` precisely because commercial
distribution was not permitted. Its author was then contacted by what he understood to be the
Department of Justice Canada asking him to strengthen the warnings; he stopped maintaining the
non-US data in 2012, and [XTide has shipped US-only ever since](https://flaterco.com/xtide/faq.html).

A published notice is not a substitute for a licence you were never granted. That is why this
repo ships code.

### There is no open alternative

Before building this, we checked whether any openly-licensed source publishes tidal **current**
constituents for Canadian waters. None does:

| Source | Why not |
|--------|---------|
| **Parker (1977), NOAA Tech Report NOS 69** | Genuinely publishes per-station current constants for 90 stations, and is US-federal public domain. But its coverage is 48.023°N–48.947°N — a search for any 49° or 50° latitude across all 62 pages returns nothing. Nearest station to Active Pass is 4.2 nm; to the Discovery Islands rapids, ~100 nm. Also only five constituents, with no overtides. |
| **WebTide / Foreman et al. (2000)** | One source, not two. Eight astronomical constituents of gridded finite-element output; the mesh does not resolve a 200 m pass as a flow-carrying channel. Carries no licence statement at all. |
| **neaps `tide-database`, XTide** | Tide **height** only, structurally — the schema has no field for flood/ebb axis, so a current station cannot be represented. |
| **NOAA Puget Sound Current Survey (2021)** | Clean, public domain, 29 constituents per station — and stops at the border. |
| **Ocean Networks Canada** | CC-BY 4.0 and genuinely independent of CHS, but its Salish Sea instruments sit in the open strait, not in the passes. |

For Canadian tidal gates, CHS is the only source. That is the whole reason this tool exists.

---

## What it does

Per station:

1. **Fetch** `wcsp1` (speed) and `wcdp1` (direction) continuous predictions from IWLS, in 7-day
   chunks, cached on disk.
2. **Project** onto the flood axis: `speed · cos(direction − floodDirection)`, giving a signed
   along-channel velocity. The projection is linear, so this is equivalent to a full 2D fit
   projected onto the same axis.
3. **Solve** for harmonic constituents by least squares over a fixed basis, using the
   astronomy (speeds, V₀, nodal f/u) from [`@neaps/tide-predictor`](https://github.com/openwatersio/neaps).
4. **Validate** (optional) against CHS's own `wcp1-events` out-of-sample, and assign a
   confidence tier.

Output conforms to [`currents.schema.json`](currents.schema.json).

## Usage

```sh
# One station, validated — good for a first run (~2 minutes)
npm run fit -- --only "Active Pass" --validate-from 2026-06-01

# All bundled Salish Sea gates, validated
npm run fit -- --validate-from 2026-06-01 --output my-currents.json

# Shorter training window (faster, but see Accuracy below)
npm run fit -- --training-days 90 --validate-from 2026-06-01
```

| Flag | Default | Notes |
|------|---------|-------|
| `--stations` | `stations/salish-sea.json` | Any `[{id, label}]` list of CHS current stations |
| `--training-days` | `210` | Length of the fitted series; below 183 the fit cannot separate K1/P1 |
| `--training-start` | `2025-07-01` | UTC start of the training series |
| `--validate-from` | *(off)* | Enables out-of-sample validation and tiering |
| `--validate-days` | `7` | Length of the validation window |
| `--request-interval` | `2.5` | Seconds between requests |
| `--only` | — | Substring match on label, repeatable |
| `--cache-dir` | `.cache` | Cached chunks; safe to delete, expensive to refill |

### How long it takes

About **52 requests per station** — 26 seven-day chunks × 2 series — which at the 2 s default
interval is roughly **1.7 minutes per station**. All 19 bundled gates take about half an hour.

Cached chunks are free, and chunks are anchored to a fixed 7-day grid rather than to your start
date, so re-running with `--training-days 90` after a 180-day run refetches **nothing**.

Start with the passes near you. Most boats never need Arran Rapids.

## Accuracy

**Accuracy is bounded by the source, not by the fit.** CHS's continuous series (`wcsp1`) is
15-minute sampled, and its own continuous extrema disagree with its precise event series
(`wcp1-events`) by 15–30 minutes at complex narrows. This tool fits the continuous series, so it
inherits that floor. Magnitudes agree to ~0.01 kn; it is the *timing* that slips.

Measured against CHS's own event predictions, out-of-sample, across the Salish Sea gates. The
headline median — and the tier — judge **extremum timing only**; slack timing is measured and
reported separately (`validationSlackMedianMin`), because at weak, slow-reversing stations the
zero crossing is far noisier than the peaks (Juan de Fuca East: ~17 min on extrema, ~83 min on
slacks). Thresholds (the authority is `TIERS` in `src/validate.ts`):

| Tier | Median extremum-timing error | Character |
|------|------------------------------|-----------|
| `high` | ≤ 5 min | Clean reversing passes |
| `medium` | ≤ 20 min | Complex narrows |
| `low` | ≤ 35 min | Violent, nonlinear rapids |
| `quarantine` | worse, or a reversed flood axis | **Do not use** |

The default training window is **210 days**, set by the Rayleigh criterion: below 183 days the
fit cannot separate K1 from P1 (which drives diurnal inequality) or S2 from K2, and below 206
it cannot separate N2/NU2 or 2N2/MU2. `fit()` reports what a given window cannot resolve.

Longer training does not help beyond that: 365 days measured no better than 180 at Dodd Narrows (49 min vs
45.5). If a gate is bad, it is bad because the physics there is nonlinear, not because the fit
is underfed.

**A reversed flood axis quarantines a station outright.** That means the fit predicts flood
where CHS says ebb — far more dangerous than a timing error, since the current is not merely
mistimed but backwards. The test is the sign of the modelled velocity at CHS's own extremum
times, and the bar is systematic disagreement (≥ 60% of extrema): a genuinely reversed axis is
wrong at nearly every peak. Occasional wrong signs are timing error at a weak station, not a
flip — an earlier nearest-event comparison conflated the two and false-quarantined three
directionally-perfect stations (Tillicum Bridge and Calamity Point both measure 0 wrong signs
under the sound test; see `test_flip_detection_uses_sign_not_nearest_event`).

**Prefer live CHS data when you have a connection.** This is an offline fallback, not a
replacement. Always carry official CHS current tables.

## Using the output

Attach the clause 10 notice wherever the data surfaces. The generated bundle carries it in its
`note` field; if you display predictions in a UI, put it somewhere a user will actually see:

> Contains information licensed under the Canadian Hydrographic Service licence agreement.
> Crown copyright is retained by His Majesty the King in Right of Canada. This product has not
> been endorsed by CHS. **Not to be used for navigation.**

And keep the output out of version control — `.gitignore` already excludes `currents.json`.

## Gotchas

These cost real debugging time. They are in the code as comments too.

- **The phase reference must match the synthesis.** V₀ is evaluated once at the series start
  and `ωt` carries it forward, exactly as `@neaps/tide-predictor` does. Reference it anywhere
  else and the fit still "succeeds" while returning collapsed amplitudes — silent and total.
  (The Python predecessor hit the same trap through utide's `epoch` argument.)
- **IWLS caps a request at 7 days** and documents 3/sec and 30/min. The default 2 s interval
  stays inside the minute limit; going faster works until it doesn't, and a throttled API is
  everyone's problem.
- **Fit and synthesis must come from the same library.** neaps and utide disagree by 180° on
  M3 and ~5° on 2N2, and at slow-reversing stations that moves slack by many minutes — see
  [`docs/validation/ts-port.md`](docs/validation/ts-port.md). Harmless while both ends of the
  round trip are neaps; not harmless if you mix engines.
- **`floodDirection` comes from CHS `/metadata`** and is occasionally wrong for the actual
  channel axis, which is what produces label flips. Validation catches it; run with
  `--validate-from`.
- **Requires a residential IP and a browser-ish User-Agent.** Datacenter IPs get refused.

## Station lists

`stations/salish-sea.json` holds the 16 BC tidal gates as `{id, label}`. The IDs are CHS's
24-hex station identifiers, which you can look up for any station through the
[IWLS API](https://api-iwls.dfo-mpo.gc.ca/swagger-ui/index.html). To fit somewhere else, write
your own list in the same shape — the tool has nothing Salish Sea specific in it.

## Licence

Code is MIT. **Output is not** — see [Why you have to run this yourself](#why-you-have-to-run-this-yourself).
