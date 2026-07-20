# Porting the fit to TypeScript

*2026-07-20. Assessment, not a commitment. Question: can `chs-constituents` become a TS
package usable from both `signalk-currents` and the browser, dropping Python + numpy + utide?*

## Bottom line

Yes, and it is a much smaller job than "port utide", because **we already switched off
everything expensive utide does**. The call in `fit_station()` is:

```python
utide.solve(tnum, velocity, lat=lat, constit=CONSTITUENTS,
            conf_int="none", method="ols", epoch="1970-01-01")
```

- `constit=CONSTITUENTS` — fixed basis, no SNR-driven auto-selection
- `method="ols"` — ordinary least squares, not robust IRLS
- `conf_int="none"` — no confidence intervals, no Monte-Carlo error propagation

Those three switches are the entire clever half of utide, and we use none of it. What is left
is *linear least squares over a known constituent basis with nodal corrections* — and that is
legitimate here because we are fitting **CHS's own predictions**, which are a clean harmonic
sum: evenly sampled, no gaps, no weather, no noise. Robust fitting and SNR pruning exist for
real observations. We do not have real observations.

The remaining hard part is the astronomy — constituent speeds, equilibrium arguments V₀,
and nodal factors f/u. **`neaps` already has all of it** (`packages/tide-predictor/src/
astronomy/`, `constituents/`, `node-corrections/` — Schureman *and* IHO), and its
`Constituent` type exposes exactly the three things a design matrix needs:

```ts
interface Constituent {
  speed: number;
  value: (astro: AstroData) => number;                  // V₀
  correction: (astro: AstroData) => NodalCorrection;    // { f, u }
}
```

So the port is: build the design matrix from neaps, solve it, done.

## The fit, in full

Height/velocity at time t over constituent set j:

```
v(t) = Z₀ + Σ f_j(t) · A_j · cos( V₀_j(t) + u_j(t) − φ_j )
```

Non-linear in (A, φ), linear in (a, b) where `a = A·cos φ`, `b = A·sin φ`:

```
v(t) = Z₀ + Σ f_j(t) · [ a_j·cos θ_j(t) + b_j·sin θ_j(t) ],   θ = V₀ + u
```

Recover `A = √(a²+b²)`, `φ = atan2(b, a)`. Ordinary linear least squares, 2N+1 unknowns.
~60 constituents → a 121×121 normal matrix over ~35k samples (a year at 15 min). Normal
equations + Cholesky, ~40 lines, no linear-algebra dependency. This is not the part that
will be hard.

## The three things that will bite

1. **`trend` defaults to `True` in utide.** We never pass `trend=False`, so the current Python
   fit includes a **linear trend term** we did not ask for. The TS design matrix must include
   the same trend column or the constituents will differ — and this is exactly the kind of
   silent mismatch that reads as "the port is broken". Decide deliberately which behaviour is
   correct rather than matching by accident; a trend in a *prediction* series is arguably noise
   we should not be fitting at all.
2. **`lat` is not decorative.** utide takes latitude for latitude-dependent nodal/phase
   adjustments. Confirm neaps' Schureman/IHO corrections reproduce utide's f/u at the same
   latitude before trusting any output. If they diverge, that is the real work of this port.
3. **The epoch trap is already documented in the Python** ("any other value silently collapses
   every frequency"). Same failure mode exists in any reimplementation. Keep the comment.

## Acceptance test — do not delete the Python until this passes

Run both pipelines over the same stations and the same window, compare:

- per-constituent amplitude and phase (the fit itself)
- reconstructed velocity RMS against CHS predictions (what actually matters)
- predicted slack/max times, which is what a user sees — minutes, not amplitudes

The Python already produces validated bundles with tiers, so this is a comparison against a
known-good, not a new validation regime. It is also a decent public artifact: two independent
implementations agreeing is a stronger accuracy claim than either alone, and it is the same
golden-vector argument the Swift engine already rests on.

## Why it is worth doing

- **One package, three consumers.** `signalk-currents` (already TS) stops shelling out to
  Python; the Slackwater PWA gets Canadian currents in-browser; the iOS app consumes the same
  JSON output. Today the fit lives in a language none of those three speak.
- **Python leaves the boat.** No numpy, no scipy, no utide on the Pi. That is a meaningful
  reduction in what can break underway on a machine nobody wants to debug at anchor.
- **The licensing posture gets *better*, not worse.** The whole design exists because CHS
  clause 3 stops anyone handing you a finished bundle, so each user must derive their own
  (see README). A TS library makes "the user runs it themselves" easier in both places it
  matters: a **`signalk-currents` config button — "Download Canadian currents data"** — that
  kicks off the fetch-and-fit on the user's own Pi, and the same code fitting in the user's own
  browser for the web build. The data never transits us in either case.

## The config-button design note

Whenever the button is built: the IWLS API is rate-limited (3 req/s, 30 req/min) and the fit
wants a long series per station, so this is a **background job with progress and resumability**,
never a blocking config action. Cache fetched series to disk so a re-run is cheap and a
half-finished download is not wasted. The existing Python client already does the polite
batching and caching — port that behaviour, not just the math.
