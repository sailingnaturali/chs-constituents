# TS port validation — measured against the Python it replaced

*2026-07-20. The Python pipeline (utide) was kept as an oracle while the TypeScript
implementation was validated against it, then removed. This records what was measured, since
the comparison harness itself can never live in this repo — it needs CHS-derived data.*

## Method

19 Salish Sea current stations, 180-day training window from 2025-07-01, validated
out-of-sample against CHS's own published `wcp1-events` for the following week.

Both implementations were given **identical input samples** (the same fetched, flood-axis-
projected series), so any difference is the fit and not the fetch. Reproduce by dumping
samples and fitted constituents from the Python at the commit before its removal
(`git log -- chs_constituents.py`), then feeding the same samples to `fit()`.

## Result: extremum timing is at parity

Median absolute timing error vs CHS extrema, TS / Python, minutes:

| Station | TS | Python | | Station | TS | Python |
|---|---|---|---|---|---|---|
| Seymour Narrows | 0.0 | 0.0 | | Blackney Passage | 8.0 | 8.0 |
| Active Pass | 1.0 | 1.0 | | Arran Rapids | 10.0 | 11.0 |
| First Narrows | 1.0 | 1.0 | | Juan de Fuca East | 14.0 | 13.5 |
| Dodd Narrows | 5.5 | 6.0 | | Johnstone Strait | 14.0 | 13.0 |
| Porlier Pass | 7.0 | 7.0 | | Beazley Passage | 14.5 | 15.0 |
| Gillard Passage | 8.0 | 8.0 | | Hole in the Wall | 15.0 | 14.0 |
| Weynton Passage | 8.0 | 8.0 | | Race Passage | 15.0 | 15.0 |
| Gabriola Passage | 21.0 | 21.0 | | Dent Rapids | 16.0 | 17.0 |
| Tillicum Bridge | 22.0 | 22.0 | | Second Narrows | 18.0 | 18.0 |
| Sechelt Rapids | 32.5 | 31.5 | | | | |

Worst difference in either direction is 1.0 minute, which is the resolution of the measure:
the Python reconstructs on a 1-minute grid and reports the sample before each crossing, while
`currentEvents` interpolates. **No station regressed meaningfully.**

Synthetic round-trip is exact independently of this: constituents synthesised by neaps and
re-fitted recover to ~1e-7 in amplitude and <0.1° in phase.

## Finding 1: utide's `trend` default made predictions worse

`utide.solve` defaults to `trend=True`, and the Python never passed `trend=False`. Fitting a
linear trend to a series of *predictions* is not physical, and extrapolating that slope across
the 180-day gap to the validation window shifts the whole curve. Enabling it to match utide
degraded slack timing at six stations — Race Passage 8.1 → 15.0 min, Juan de Fuca East
17.7 → 23.9, Beazley 3.2 → 5.2, Gillard 2.8 → 5.2, Dent 5.1 → 6.7, Arran 3.1 → 5.1.

With the trend off, the fitted mean term agrees with the Python's to four decimal places at
every station checked. **`fit()` therefore defaults `trend` to false**, and the option exists
only to reproduce legacy utide bundles.

## Finding 2: the 180-day default cannot separate six constituent pairs

The Rayleigh criterion needs a record at least as long as a pair's synodic period. At the
Python's default 180-day window, the basis contains:

| Pair | Needs |
|---|---|
| S2 / T2 | 366 d |
| N2 / NU2, 2N2 / MU2 | 206 d |
| S2 / K2, K1 / P1, MSF / MF | 183 d |

utide does not refuse these either — it returns values and the split between each pair is
whatever least squares lands on. K1/P1 matters most: it drives diurnal inequality, which is
what makes PNW currents asymmetric. **The CLI default is now 210 days**, which clears
everything except S2/T2. `fit()` reports unresolvable pairs in `unseparable` rather than
throwing, because predictions are noise-free and the validation stage is the real gate.

## Finding 3 (open): neaps and utide disagree at slow-reversing stations

Slack timing did *not* reach parity at two stations: Juan de Fuca East (TS 17.7 vs Python 9.5
min) and Race Passage (8.1 vs 5.5). Three hypotheses were tested and two eliminated:

- **Not the mean term** — offsets agree to four decimals with `trend` off.
- **Not basis degeneracy** — refitting both at 240 days left the gap unchanged.
- **It is the synthesis engine.** Feeding the *Python's own fitted constituents* through
  neaps' synthesis and comparing to the Python's own predicted events isolates the engines:
  median slack difference is **24.6 min at Juan de Fuca East**, 8.1 at Tillicum Bridge, 5.0 at
  Race Passage, and under ~2.5 min everywhere else. Extrema differ by ≤6 min throughout.

No single constituent explains it — dropping M3, 2N2, MU2, MSF, MF, J1 or T2 individually
moves Juan de Fuca East by at most 5 minutes (K2 is the largest single contributor, 24.6 →
19.4). Two known convention differences exist between the libraries (utide encodes M3's 180°
offset as `semi=-0.5`, neaps as extended-Doodson digit 7; 2N2 phase differs by a consistent
~5°), but neither accounts for the magnitude alone.

Both engines are internally self-consistent — each reproduces its own synthesis when re-fitted
— so this is a difference in astronomical argument or nodal correction, amplified at weak,
slow-reversing stations where a small velocity error moves the zero crossing by many minutes.
Against CHS ground truth neither wins outright: utide is closer at Juan de Fuca East and Race
Passage, neaps is closer at Blackney, Tillicum, Sechelt and Hole in the Wall.

This is worth pursuing upstream, since neaps underpins more than this package. It does not
block the port: extremum timing is at parity, the per-station validation tiers measure slack
error honestly and separately, and the whole stack is neaps-based, so agreeing with neaps is
the more useful consistency.
