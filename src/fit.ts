import { astro, constituents as constituentModels } from "@neaps/tide-predictor";

const d2r = Math.PI / 180;

/**
 * Nodal corrections drift on the 18.6-year cycle (<0.01%/day), so both neaps'
 * synthesis and this fit hold f/u constant across a chunk and recompute at the
 * chunk midpoint. Same value neaps uses — the two must agree or the fit is not
 * the inverse of the prediction.
 */
const CORRECTION_INTERVAL_HOURS = 24;

export interface Sample {
  time: Date;
  /** Water level, or velocity already projected onto the flood axis. */
  value: number;
}

export interface FitOptions {
  /** Constituent names to solve for. Fixed basis — no SNR-driven selection. */
  constituents: string[];
  /**
   * Fit a linear trend alongside the constituents. utide does this by DEFAULT
   * (`trend=True`), which is why its output and a naive port disagree. A trend
   * in a series of *predictions* is not physical, so we default to off — turn
   * it on only to reproduce legacy utide bundles. See docs/ts-port.md.
   */
  trend?: boolean;
  correctionIntervalHours?: number;
}

export interface FittedConstituent {
  name: string;
  /** Same units as the input samples. */
  amplitude: number;
  /** Degrees, 0–360, in neaps' convention (phase lag on V₀+u). */
  phase: number;
}

export interface UnseparablePair {
  constituents: [string, string];
  /** Series length the Rayleigh criterion wants to tell these two apart. */
  requiredDays: number;
}

export interface FitResult {
  constituents: FittedConstituent[];
  /** Mean term Z₀. */
  offset: number;
  /** Per-hour slope, only present when `trend` was requested. */
  trend?: number;
  /** Fit residual against the input samples, same units. */
  rms: number;
  /**
   * Constituent pairs the series is formally too short to resolve (Rayleigh).
   * Reported, not enforced: predictions are noise-free, so a fit often recovers
   * such a pair anyway, and the pipeline's validation stage is the real gate.
   * Empty means every requested pair is separable on length alone.
   */
  unseparable: UnseparablePair[];
}

/**
 * Rayleigh criterion: two constituents need a record at least as long as their
 * synodic period, 360/Δspeed hours. This is what decides how many days of CHS
 * data to fetch — P1 and K1 sit 0.082°/hr apart and want ~183 days.
 */
function unseparablePairs(
  models: { name: string; speed: number }[],
  spanHours: number,
): UnseparablePair[] {
  const pairs: UnseparablePair[] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const delta = Math.abs(models[i].speed - models[j].speed);
      const requiredHours = delta === 0 ? Infinity : 360 / delta;
      if (requiredHours > spanHours) {
        pairs.push({
          constituents: [models[i].name, models[j].name],
          requiredDays: Math.ceil(requiredHours / 24),
        });
      }
    }
  }
  return pairs.sort((a, b) => b.requiredDays - a.requiredDays);
}

/**
 * Solve for harmonic constituents by least squares over a known basis.
 *
 * This is the whole of what we used utide for: `constit` fixed, `method="ols"`,
 * `conf_int="none"`. Robust fitting and SNR pruning exist for noisy observations;
 * we fit published predictions, which are a clean harmonic sum. The astronomy —
 * speeds, V₀, and nodal f/u — comes from neaps, so a fit here inverts a synthesis
 * there exactly.
 *
 * Model, matching `prepareParams` in @neaps/tide-predictor:
 *
 *     v(t) = Z₀ + Σ fⱼ(t)·Aⱼ·cos( ωⱼ·t + V₀ⱼ + uⱼ(t) − φⱼ )
 *
 * which is non-linear in (A, φ) but linear in (a, b) where a = A·cos φ and
 * b = A·sin φ, giving an ordinary least-squares problem in 2N+1 unknowns.
 */
export function fit(samples: Sample[], options: FitOptions): FitResult {
  const {
    constituents: names,
    trend = false,
    correctionIntervalHours = CORRECTION_INTERVAL_HOURS,
  } = options;

  if (samples.length < 2) {
    throw new Error("fit needs at least two samples");
  }

  const unknown = names.find((name) => !constituentModels[name]);
  if (unknown) {
    throw new Error(`Unknown constituent: ${unknown}`);
  }

  // V₀ is evaluated once at the series start; ωt carries the phase forward.
  // This is neaps' convention, and getting it wrong silently collapses every
  // frequency — the same trap the Python documents about utide's `epoch`.
  const baseTime = samples[0].time;
  const baseMs = baseTime.getTime();
  const baseAstro = astro(baseTime);

  const models = names.map((name) => {
    const model = constituentModels[name];
    return {
      name,
      speed: model.speed,
      w: d2r * model.speed,
      v0: d2r * model.value(baseAstro),
      model,
    };
  });

  const hours = samples.map((s) => (s.time.getTime() - baseMs) / 3_600_000);
  const unseparable = unseparablePairs(models, hours[hours.length - 1] - hours[0]);

  // f/u per constituent per chunk, computed at the chunk midpoint.
  const corrections = new Map<number, { f: number; u: number }[]>();
  const correctionsAt = (hour: number) => {
    const chunk = Math.floor(hour / correctionIntervalHours);
    let cached = corrections.get(chunk);
    if (!cached) {
      const midpoint = new Date(baseMs + (chunk + 0.5) * correctionIntervalHours * 3_600_000);
      const chunkAstro = astro(midpoint);
      cached = models.map(({ model }) => {
        const correction = model.correction(chunkAstro);
        return { f: correction.f, u: d2r * correction.u };
      });
      corrections.set(chunk, cached);
    }
    return cached;
  };

  // Design matrix columns: [Z₀] [t?] then [f·cos θ, f·sin θ] per constituent.
  const trendColumns = trend ? 1 : 0;
  const width = 1 + trendColumns + 2 * models.length;

  const row = new Float64Array(width);
  const buildRow = (index: number) => {
    const hour = hours[index];
    const correction = correctionsAt(hour);
    row[0] = 1;
    if (trend) row[1] = hour;
    for (let j = 0; j < models.length; j++) {
      const { w, v0 } = models[j];
      const { f, u } = correction[j];
      const theta = w * hour + v0 + u;
      const at = 1 + trendColumns + 2 * j;
      row[at] = f * Math.cos(theta);
      row[at + 1] = f * Math.sin(theta);
    }
    return row;
  };

  // Normal equations. ponytail: O(n·m²), measured at 124 ms for a year of
  // 15-minute samples against the 23-constituent CHS basis — fast enough to run
  // in a browser tab. Switch to a QR/Householder solve if conditioning bites;
  // normal equations square the condition number, which is why the Cholesky
  // failure below is a real possibility rather than a formality.
  const xtx = new Float64Array(width * width);
  const xty = new Float64Array(width);
  for (let i = 0; i < samples.length; i++) {
    const r = buildRow(i);
    const y = samples[i].value;
    for (let a = 0; a < width; a++) {
      if (r[a] === 0) continue;
      xty[a] += r[a] * y;
      for (let b = a; b < width; b++) {
        xtx[a * width + b] += r[a] * r[b];
      }
    }
  }
  for (let a = 0; a < width; a++) {
    for (let b = 0; b < a; b++) {
      xtx[a * width + b] = xtx[b * width + a];
    }
  }

  const solution = choleskySolve(xtx, xty, width);

  const fitted: FittedConstituent[] = models.map(({ name }, j) => {
    const at = 1 + trendColumns + 2 * j;
    const a = solution[at];
    const b = solution[at + 1];
    const phase = (Math.atan2(b, a) / d2r + 360) % 360;
    return { name, amplitude: Math.hypot(a, b), phase };
  });

  let squared = 0;
  for (let i = 0; i < samples.length; i++) {
    const r = buildRow(i);
    let modelled = 0;
    for (let a = 0; a < width; a++) modelled += r[a] * solution[a];
    const residual = samples[i].value - modelled;
    squared += residual * residual;
  }

  return {
    constituents: fitted,
    offset: solution[0],
    ...(trend ? { trend: solution[1] } : {}),
    rms: Math.sqrt(squared / samples.length),
    unseparable,
  };
}

/** Solve a symmetric positive-definite system in place. */
function choleskySolve(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const l = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) sum -= l[i * n + k] * l[j * n + k];
      if (i === j) {
        if (sum <= 0) {
          // Rank deficiency, in practice: two constituents too close in frequency
          // to separate over a series this short (Rayleigh criterion).
          throw new Error(
            "Normal matrix is not positive definite — the series is likely too " +
              "short to separate the requested constituents",
          );
        }
        l[i * n + i] = Math.sqrt(sum);
      } else {
        l[i * n + j] = sum / l[j * n + j];
      }
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * y[k];
    y[i] = sum / l[i * n + i];
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}
