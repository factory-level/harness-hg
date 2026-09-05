// Emit the Hermes live mark's canonical still frame as SVG.
//
// The field, the marching-squares tracer and drawSurface are ported verbatim
// from dashboard/src/mark.tsx — same constants, same sample grid, same levels.
// The only change is the sink: instead of stroking into a 2D context, the
// segments are collected and written as SVG path data, so the mark scales.
//
// Frame t = 4.2s is the brand's canonical still (mark.tsx: `t0 =
// performance.now() - 4200`). Size 64 / density 4 are the corner lockup's own
// arguments (dashboard/src/index.tsx:2294), so this reproduces exactly the mark
// rendered bottom-right on the fleet canvas.

function h3(i, j, k) {
  let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  n = ((n ^ (n >> 13)) * 1274126177) | 0;
  return ((n ^ (n >> 16)) & 0x7fffffff) / 0x3fffffff - 1;
}

function n3(x, y, z) {
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

function fbm(x, y, z) {
  return n3(x, y, z) * 0.62 + n3(x * 2.07, y * 2.07, z * 2.07) * 0.28 + n3(x * 4.13, y * 4.13, z * 4.13) * 0.12;
}

function march(out, arr, Nx, Ny, ox, oy, sx, sy, L) {
  for (let j = 0; j < Ny - 1; j++) {
    for (let i = 0; i < Nx - 1; i++) {
      const k = j * Nx + i;
      const a = arr[k], b = arr[k + 1], c = arr[k + Nx + 1], d = arr[k + Nx];
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
      const seg = (x1, y1, x2, y2) => out.push([x1, y1, x2, y2]);
      switch (m) {
        case 1: case 14: seg(tx, ty, lx, ly); break;
        case 2: case 13: seg(tx, ty, rx, ry); break;
        case 3: case 12: seg(lx, ly, rx, ry); break;
        case 4: case 11: seg(rx, ry, bx, by); break;
        case 6: case 9: seg(tx, ty, bx, by); break;
        case 7: case 8: seg(lx, ly, bx, by); break;
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

const R_FRAC = 0.35, AMP = 0.36, SCALE = 2.9, WOBBLE = 0.4;
const TOPO_W = 1.9, RIM_W = 2.8, MIN_W = 1;

function surface(t, S, density) {
  const cx = S / 2, cy = S / 2, R = S * R_FRAC;
  const sw = Math.max(0.42, Math.min(1, S / 420));
  const topoW = Math.max(MIN_W, TOPO_W * sw);
  const rimW = Math.max(MIN_W * 1.3, RIM_W * sw);

  const Nx = Math.max(52, Math.min(132, Math.round(S * 0.24))), Ny = Nx;
  const bxf = 1.42;
  const x0 = cx - R * bxf, y0 = cy - R * bxf;
  const sx = (R * bxf * 2) / (Nx - 1), sy = (R * bxf * 2) / (Ny - 1);

  const E = new Float64Array(Nx * Ny), G = new Float64Array(Nx * Ny);
  const rot = t * 0.11, cr = Math.cos(rot), sr = Math.sin(rot);
  const drift = t * 0.24;

  for (let j = 0; j < Ny; j++) {
    const py = y0 + j * sy;
    for (let i = 0; i < Nx; i++) {
      const px = x0 + i * sx;
      const ax = px - cx, ay = py - cy;
      const dd = Math.sqrt(ax * ax + ay * ay) + 1e-6;
      const Rw = R * (1 + WOBBLE * 0.17 * fbm((ax / dd) * 2.3, (ay / dd) * 2.3, t * 0.55));
      const f = (Rw * Rw) / (ax * ax + ay * ay + 1e-6);
      const idx = j * Nx + i;
      G[idx] = f - 1;
      if (f <= 1) { E[idx] = 0; continue; }
      const z = Math.sqrt(1 - 1 / f);
      const nx = ax / R, ny = ay / R;
      const rx = nx * cr - z * sr, rz = nx * sr + z * cr;
      E[idx] = z + AMP * fbm(rx * SCALE, ny * SCALE, rz * SCALE + drift);
    }
  }

  const topo = [], rim = [];
  const step = 1 / density;
  for (let L = step; L < 1.45; L += step) march(topo, E, Nx, Ny, x0, y0, sx, sy, L);
  march(rim, G, Nx, Ny, x0, y0, sx, sy, 0);
  return { topo, rim, topoW, rimW };
}

// --- emit -----------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const r = (n) => Math.round(n * 100) / 100;
const d = (segs) => segs.map(([a, b, c, e]) => `M${r(a)} ${r(b)}L${r(c)} ${r(e)}`).join("");

const S = 64, DENSITY = 4, T = 4.2;
const { topo, rim, topoW, rimW } = surface(T, S, DENSITY);

const PROVENANCE = `  <!-- The Hermes mark: a body of mercury described entirely in contour lines.
       GENERATED — never hand-edit. Traced from the live surface in
       dashboard/src/mark.tsx at its canonical still frame (t=4.2s, size 64,
       density 4), the same arguments the fleet canvas gives its corner lockup
       (dashboard/src/index.tsx). Same field, same marching-squares tracer, same
       constants; only the sink differs. No gloss, no gradients.
       Regenerate: node infra/scripts/generate-mark-svg.mjs -->`;

const body = (stroke) => `  <g stroke-width="${r(topoW)}" opacity="0.85">
    <path d="${d(topo)}"/>
  </g>
  <g stroke-width="${r(rimW)}">
    <path d="${d(rim)}"/>
  </g>`;

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" fill="none"
     stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
${PROVENANCE}
${body()}
</svg>
`;

// The favicon cannot inherit a page colour, and a browser will not apply the
// site theme to it, so it is fixed: the mark in ink on the canvas ground, which
// is what Nexus shows by default.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" fill="none">
${PROVENANCE}
  <rect width="${S}" height="${S}" rx="14" fill="#0b0d14"/>
  <g stroke="#ebeaf4" stroke-linecap="round" stroke-linejoin="round">
${body()}
  </g>
</svg>
`;

const here = path.dirname(url.fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "..", "_docs", "wiki", "assets");
const out = [
  [path.join(assets, "mark.svg"), mark],
  [path.join(assets, "favicon.svg"), favicon],
];

const check = process.argv.includes("--check");
let drift = false;
for (const [file, content] of out) {
  if (check) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (have !== content) {
      console.error(`drift: ${path.relative(process.cwd(), file)} is stale — run: node infra/scripts/generate-mark-svg.mjs`);
      drift = true;
    }
  } else {
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}
if (drift) process.exit(1);
