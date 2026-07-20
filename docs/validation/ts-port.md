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

## Finding 3: neaps and utide disagree at slow-reversing stations

*Recorded as open when first written; root-caused the same day — see the resolution below.
Kept as-written because the eliminations it records are what made the resolution findable.*

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

## Finding 3, resolved: it is the nodal corrections, and the fit absorbs most of it

*2026-07-20, same day.* The ablation above compared **outputs**. Comparing the engines'
**internals** settles it directly, and needs no CHS data at all — both libraries expose their
per-constituent astronomical argument and nodal terms, so this probe *is* reproducible in
this repo, unlike the event comparison. neaps gives V via `constituents[name].value(astro(t))`
and f/u via `.correction(astro(t))`; utide gives all three from
`utide.harmonics.FUV(t, tref, lind, lat, [0,0,0,0])`. Constituent identity was checked by
frequency, matching to 1e-7 °/h across the basis, so the columns really are the same waves.

**It is not the astronomical argument.** V agrees between the engines to **0.00°** on every
constituent in the basis. The one exception is M3's known 180° offset, which is in V, not u.

**It is not the `V₀ + ωt` convention either** — a hypothesis not tested above. neaps' tabulated
`speed` matches the time derivative of its own `value()` to ~1e-8 °/h; total phase drift over
the 187-day training-plus-validation span is under 0.0002° for every constituent. The
linear-phase shortcut is sound.

**It is the nodal corrections, and it is a convention difference rather than a bug.** neaps
*groups* constituents by IHO Annex B nodal-correction code, and constituents sharing a code
share f/u exactly: M2, N2, 2N2, MU2 and NU2 agree to nine decimals, as do O1 and Q1. utide
applies Foreman's *satellite-derived per-constituent* factors, where each constituent gets its
own. The largest split is 2N2: f = 0.965 in neaps (M2's value) against 1.110 in utide, a 13%
difference, with ~3.6° of phase alongside it. Neither is wrong; grouped is the classical
approximation and satellite-Foreman the refined one.

Be careful with the label here. neaps ships **two** fundamentals sets — `iho` and `schureman` —
and `correction(astro, fundamentals = fundamentals$2)` defaults to **`iho`**, which is what
both `fit()` and everything above use. They are not interchangeable: switching to `schureman`
moves J1 by 7.2% and MF by 5.5%. That intra-library spread is *larger* than several of the
neaps-versus-utide gaps this section is about — J1 differs by 7.2% between neaps' own two modes
against 1.5% between neaps and utide — which is a useful reminder that "which nodal convention"
is a bigger lever than "which library".

That is also why the ablation found no culprit. The disagreement is spread thin across 2N2,
M2, MM, J1 and N2 with no dominant term, so dropping constituents one at a time could never
surface it.

**Most of it never reaches the output.** The 24.6 min figure comes from feeding utide's
constituents through neaps' synthesis — nothing is re-fitted there, so the full disagreement
lands in the prediction. The shipped pipeline fits *and* synthesises in neaps, so any constant
f/u offset is absorbed into the fitted amplitude and phase. Only the drift across the
training-to-validation span survives. Weighted by the fitted amplitudes at Dodd Narrows:

| | velocity error |
|---|---|
| raw cross-engine — the regime the 24.6 min was measured in | 2.9% of M2 |
| post-fit residual — the regime that actually ships | **0.72% of M2** |

0.72% of M2 is roughly 0.85 min at an ordinary zero crossing. Multiplied by the ~7×
amplification a slow reversal gives, that lands on the 8.2 min TS-vs-Python slack gap observed
at Juan de Fuca East. The mechanism and the magnitude both check out, and **the 24.6 min
number overstates the shipped impact by about 4×.**

**M3 is retired as a concern.** Its 180° offset is constant — drift 0.03° over the span — so
the fit absorbs it completely. It is bookkeeping, with no effect on output.

One asymmetry worth recording: utide returns f = 1.0 and u = 0.0 exactly for MM, MSF and MF,
i.e. no nodal correction at all on the long-period constituents, where neaps applies the
Schureman factors. That looks like a genuine gap on utide's side rather than neaps'. It
barely matters for currents, where those amplitudes are small.

**Conclusion: not worth chasing.** The residual sits below the CHS validation floor, and
neither engine wins against ground truth. Adopting Foreman factors in neaps would be real work
with no evidence it improves anything. The characterisation is still worth sending upstream,
since neaps underpins signalk-tides and TideEngine as well as this package, but as a
documentation note rather than a defect. The port stands: extremum timing is at parity, the
per-station validation tiers measure slack error honestly and separately, and the whole stack
is neaps-based, so agreeing with neaps is the more useful consistency.
