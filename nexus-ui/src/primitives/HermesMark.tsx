// The Hermes mark (Hermes Brand Guide, "Our mark, in motion" / "How small it
// can go"). The mark is a body of mercury described entirely in contour lines:
// a metaball field sampled on a grid, sliced at evenly spaced levels, and
// traced with marching squares. No gloss, no gradients, nothing pretending to
// be a photograph - and it is drawn live, never a still image.
//
// TWO components, because the brand has two states and the rule for choosing
// is size:
//
//   HermesMarkLive  - the surface, redrawn every frame. "Let it move": the
//                     website, a splash, and while the product is genuinely
//                     working. Needs >= 40px or the contour levels land closer
//                     together than a stroke is wide.
//   HermesMark      - the reduced glyph: rim plus fixed eccentric loops, still,
//                     as vector. "Let it rest": nav bars, icons, anything tiny.
//
// The noise, the field and the marching-squares tracer below are ported from
// the brand source verbatim. Two of its branches are omitted rather than
// carried dead: the source hardcodes `dripRaw = 0` (so the falling-bead
// metaballs never contribute) and `chrome = false` (so the chrome gradient
// never paints). Its glow pass only fires above 120px, which no mark in this
// UI reaches. Keep it that way - "don't add gloss or gradients".

import { React } from "../sdk";

// --- the field ------------------------------------------------------------
// 3D value noise: integer hash -> smoothstep-interpolated lattice -> 3 octaves.

function h3(i: number, j: number, k: number): number {
  let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  n = ((n ^ (n >> 13)) * 1274126177) | 0;
  return ((n ^ (n >> 16)) & 0x7fffffff) / 0x3fffffff - 1;
}

function n3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const c000 = h3(xi, yi, zi), c100 = h3(xi + 1, yi, zi);
  const c010 = h3(xi, yi + 1, zi), c110 = h3(xi + 1, yi + 1, zi);
  const c001 = h3(xi, yi, zi + 1), c101 = h3(xi + 1, yi, zi + 1);
  const c011 = h3(xi, yi + 1, zi + 1), c111 = h3(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm(x: number, y: number, z: number): number {
  return (
    n3(x, y, z) * 0.62 +
    n3(x * 2.07, y * 2.07, z * 2.07) * 0.28 +
    n3(x * 4.13, y * 4.13, z * 4.13) * 0.12
  );
}

// Marching squares over `arr`, emitting segments into the current path.
function march(
  ctx: CanvasRenderingContext2D, arr: Float32Array, Nx: number, Ny: number,
  ox: number, oy: number, sx: number, sy: number, L: number,
): void {
  for (let j = 0; j < Ny - 1; j++) {
    for (let i = 0; i < Nx - 1; i++) {
      const k = j * Nx + i;
      const a = arr[k]!, b = arr[k + 1]!, c = arr[k + Nx + 1]!, d = arr[k + Nx]!;
      let m = 0;
      if (a > L) m |= 1;
      if (b > L) m |= 2;
      if (c > L) m |= 4;
      if (d > L) m |= 8;
      if (m === 0 || m === 15) continue;
      const px = ox + i * sx, py = oy + j * sy;
      const tx = px + sx * (L - a) / (b - a), ty = py;
      const rx = px + sx, ry = py + sy * (L - b) / (c - b);
      const bx = px + sx * (L - d) / (c - d), by = py + sy;
      const lx = px, ly = py + sy * (L - a) / (d - a);
      const seg = (x1: number, y1: number, x2: number, y2: number): void => {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      };
      switch (m) {
        case 1: case 14: seg(tx, ty, lx, ly); break;
        case 2: case 13: seg(tx, ty, rx, ry); break;
        case 3: case 12: seg(lx, ly, rx, ry); break;
        case 4: case 11: seg(rx, ry, bx, by); break;
        case 6: case 9: seg(tx, ty, bx, by); break;
        case 7: case 8: seg(lx, ly, bx, by); break;
        // Saddles: the cell midpoint decides which way the two arcs pair up.
        case 5:
          if ((a + b + c + d) / 4 > L) { seg(tx, ty, rx, ry); seg(lx, ly, bx, by); }
          else { seg(tx, ty, lx, ly); seg(rx, ry, bx, by); }
          break;
        case 10:
          if ((a + b + c + d) / 4 > L) { seg(tx, ty, lx, ly); seg(rx, ry, bx, by); }
          else { seg(tx, ty, rx, ry); seg(lx, ly, bx, by); }
          break;
      }
    }
  }
}

// Brand constants. `density` is contour lines per unit of field, so it is the
// knob that keeps small marks legible: too many levels at a small size and the
// lines merge into a disc, which the guide explicitly forbids.
const R_FRAC = 0.35, AMP = 0.36, SCALE = 2.9, WOBBLE = 0.4;
const TOPO_W = 1.9, RIM_W = 2.8, MIN_W = 1;

function drawSurface(
  canvas: HTMLCanvasElement, t: number, S: number, dpr: number,
  density: number, ink: string, fields: { E: Float32Array; G: Float32Array },
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const cx = S / 2, cy = S / 2, R = S * R_FRAC;
  const sw = Math.max(0.42, Math.min(1, S / 420));
  const topoW = Math.max(MIN_W, TOPO_W * sw);
  const rimW = Math.max(MIN_W * 1.3, RIM_W * sw);

  const Nx = Math.max(52, Math.min(132, Math.round(S * 0.24))), Ny = Nx;
  const bxf = 1.42;
  const x0 = cx - R * bxf, y0 = cy - R * bxf;
  const sx = (R * bxf * 2) / (Nx - 1), sy = (R * bxf * 2) / (Ny - 1);

  const { E, G } = fields;
  const R2 = R * R;
  const rot = t * 0.11, cr = Math.cos(rot), sr = Math.sin(rot);
  const drift = t * 0.24;

  for (let j = 0; j < Ny; j++) {
    const py = y0 + j * sy;
    for (let i = 0; i < Nx; i++) {
      const px = x0 + i * sx;
      const ax = px - cx, ay = py - cy;
      // The rim breathes: the radius itself is noise-modulated, so the
      // silhouette swells and settles instead of holding a perfect circle.
      const dd = Math.sqrt(ax * ax + ay * ay) + 1e-6;
      const Rw = R * (1 + WOBBLE * 0.17 * fbm((ax / dd) * 2.3, (ay / dd) * 2.3, t * 0.55));
      const f = (Rw * Rw) / (ax * ax + ay * ay + 1e-6);
      const idx = j * Nx + i;
      G[idx] = f - 1;
      if (f <= 1) { E[idx] = 0; continue; }
      // Lift the disc into a hemisphere, spin the sample point about the
      // vertical, then perturb by drifting noise: that is the surface.
      const z = Math.sqrt(1 - 1 / f);
      const nx = ax / R, ny = ay / R;
      const rx = nx * cr - z * sr, rz = nx * sr + z * cr;
      E[idx] = z + AMP * fbm(rx * SCALE, ny * SCALE, rz * SCALE + drift);
    }
  }

  ctx.strokeStyle = ink;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.globalAlpha = 0.85;
  ctx.lineWidth = topoW;
  ctx.beginPath();
  const step = 1 / density;
  for (let L = step; L < 1.45; L += step) march(ctx, E, Nx, Ny, x0, y0, sx, sy, L);
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.lineWidth = rimW;
  ctx.beginPath();
  march(ctx, G, Nx, Ny, x0, y0, sx, sy, 0);
  ctx.stroke();
}

/**
 * The live mark. Needs >= 40px - below that use HermesMark.
 *
 * `density` is required on purpose: it has to fall as the mark shrinks, so
 * there is no safe default. The brand animates at 128px/density 8; at 64px
 * anything above 4 merges the contours into a disc.
 */
export function HermesMarkLive({ size, density }: { size: number; density: number }): React.ReactElement {
  const { useEffect, useRef } = React;
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const N = Math.max(52, Math.min(132, Math.round(size * 0.24)));
    const fields = { E: new Float32Array(N * N), G: new Float32Array(N * N) };

    // 4.2s is the brand's canonical still frame. Start the clock there rather
    // than at zero, so the frame painted below and the loop's first frame are
    // the same one and nothing jumps.
    const t0 = performance.now() - 4200;
    // A canvas cannot stroke `currentColor`, so the ink is resolved here - and
    // resolved EVERY frame, not once: the effect does not re-run when the gear
    // menu flips the theme, so a hoisted colour would keep painting the dark
    // theme's near-white contours onto the light theme's paper.
    const frame = (now: number): void =>
      drawSurface(canvas, (now - t0) / 1000, size, dpr, density, getComputedStyle(canvas).color, fields);

    // Paint once, synchronously, before any rAF: requestAnimationFrame does
    // not fire in a background tab, so a loop-only mark stays a blank hole
    // until the tab is first focused - which is exactly what a restored
    // session or a middle-click open looks like.
    frame(performance.now());

    // "If the motion ever feels urgent, it's wrong" - 30fps, and reduced
    // motion keeps the frame already drawn above.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let last = 0;
    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - last < 33) return;
      last = now;
      frame(now);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [size, density]);

  return (
    <canvas
      ref={ref}
      className="nx-mark-live"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

/** The reduced glyph: still, vector, for chrome and anything under 40px. */
/** The control-plane OWNERSHIP marker (#554): the smallest sphere, inline.
 * It says "this record belongs to the Hermes control plane, not an
 * installed bundle" - provenance, never health, so it takes the text ink
 * beside it and no status color, and the meaning never depends on
 * recognizing the graphic (role/label carry it). Baseline-safe: an
 * inline-flex box exactly `size` tall, vertically centered by the row it
 * sits in. */
export function HermesOwnerMark({ size = 14 }: { size?: number }): React.ReactElement {
  return (
    <span
      className="nx-own"
      role="img"
      aria-label="Owned by the Hermes control plane"
      title="Owned by the Hermes control plane"
      style={{ width: size, height: size }}
    >
      <HermesMark size={size} />
    </span>
  );
}

export function HermesMark({ size }: { size: number }): React.ReactElement {
  // Geometry is the brand drawGlyph's, normalised to a 100-unit box: R = 36 of
  // 100, loop stroke 4.4, rim stroke 6.2 inset to r = 32.9. The loops are
  // deliberately NOT concentric - that is what keeps it reading as a contour
  // map instead of a target - and the second keeps its 0.42pi-2.16pi opening.
  // Below 30px the brand drops the third loop, and it is right to: at chrome
  // sizes that loop stops resolving and fills in as a smudge.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <g strokeWidth="4.4">
        <ellipse cx="46.76" cy="44.6" rx="25.56" ry="20.52" transform="rotate(-19.48 46.76 44.6)" />
        <path d="M37.47 48.34A13.68 9.72 29.79 1 1 47.28 48.5" />
        {size >= 30 && (
          <ellipse cx="60.8" cy="60.8" rx="10.8" ry="7.56" transform="rotate(-13.75 60.8 60.8)" />
        )}
      </g>
      <circle cx="50" cy="50" r="32.9" strokeWidth="6.2" />
    </svg>
  );
}

// Carried verbatim from dashboard/src/mark.tsx (the brand algorithm is
// a spec-bearing asset, not app structure - ADR 0168): only the sdk
// import path changed.
