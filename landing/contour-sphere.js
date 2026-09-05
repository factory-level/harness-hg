// Contour-sphere brand mark — flat-ink contour lines over a wobbling liquid membrane.
// Extracted from the "Deep relief" master so it can be mounted at any size.
//
// Originally vendored from the "Hermes GitOps Nexus specification" Claude
// Design project. NO LONGER VERBATIM: the membrane now takes a direction and a
// strength so it can be pulled toward a pointer or toward whichever interface
// is active, and gathers light on the pulled side. See landing/README.md.
(function () {
  function h3(i, j, k) {
    var n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
    n = (n ^ (n >> 13)) * 1274126177 | 0;
    return (((n ^ (n >> 16)) & 0x7fffffff) / 0x3fffffff) - 1;
  }
  function n3(x, y, z) {
    var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    var xf = x - xi, yf = y - yi, zf = z - zi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    var c000 = h3(xi, yi, zi), c100 = h3(xi + 1, yi, zi), c010 = h3(xi, yi + 1, zi), c110 = h3(xi + 1, yi + 1, zi);
    var c001 = h3(xi, yi, zi + 1), c101 = h3(xi + 1, yi, zi + 1), c011 = h3(xi, yi + 1, zi + 1), c111 = h3(xi + 1, yi + 1, zi + 1);
    var x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
    var x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    var y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }
  function fbm(x, y, z) {
    return n3(x, y, z) * 0.62 + n3(x * 2.07, y * 2.07, z * 2.07) * 0.28 + n3(x * 4.13, y * 4.13, z * 4.13) * 0.12;
  }

  function march(ctx, arr, Nx, Ny, ox, oy, sx, sy, L) {
    for (var j = 0; j < Ny - 1; j++) {
      for (var i = 0; i < Nx - 1; i++) {
        var k = j * Nx + i;
        var a = arr[k], b = arr[k + 1], c = arr[k + Nx + 1], d = arr[k + Nx];
        var m = 0;
        if (a > L) m |= 1; if (b > L) m |= 2; if (c > L) m |= 4; if (d > L) m |= 8;
        if (m === 0 || m === 15) continue;
        var px = ox + i * sx, py = oy + j * sy;
        var tx = px + sx * (L - a) / (b - a), ty = py;
        var rx = px + sx, ry = py + sy * (L - b) / (c - b);
        var bx = px + sx * (L - d) / (c - d), by = py + sy;
        var lx = px, ly = py + sy * (L - a) / (d - a);
        var seg = function (x1, y1, x2, y2) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); };
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

  var E = null, G = null;

  // canvas: target (already sized to size*dpr). cfg: {ink, density, rFrac, amp, scale,
  // wobble, topoW, rimW, minW, rimOnly, pullX, pullY, pull, offX, offY, lightInk}
  //
  // The pull fields make the membrane directional: `pullX/pullY` is a unit
  // vector toward whatever is attracting it (a pointer, or the interface that
  // is currently active), `pull` is 0..1 strength, and `offX/offY` displace the
  // whole body. Volume reads as preserved because the far side compresses by a
  // fraction of whatever the near side gains.
  function draw(canvas, t, size, dpr, cfg) {
    cfg = cfg || {};
    var S = size;
    var ink = cfg.ink || '#EDE8E0';
    var pull = cfg.pull || 0;
    var pux = cfg.pullX || 0, puy = cfg.pullY || 0;
    var density = Math.max(3, cfg.density || 13);
    var amp = cfg.amp != null ? cfg.amp : 0.36;
    var scale = cfg.scale != null ? cfg.scale : 2.9;
    var wobble = cfg.wobble != null ? cfg.wobble : 0.4;
    var sw = Math.max(0.42, Math.min(1, S / 420));
    var topoW = Math.max(cfg.minW || 0, (cfg.topoW || 1.9) * sw);
    var rimW = Math.max((cfg.minW || 0) * 1.3, (cfg.rimW || 2.8) * sw);

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    var cx = S / 2 + (cfg.offX || 0), cy = S / 2 + (cfg.offY || 0);
    var R = S * (cfg.rFrac || 0.35);
    // Grid density is capped harder than the original: this sphere is now
    // re-marched every frame it deforms, and the noise is the expensive part.
    var Nx = Math.max(40, Math.min(cfg.maxGrid || 132, Math.round(S * 0.24)));
    var Ny = Nx;
    // Wider sampling box so a displaced, bulging body stays inside it.
    var bxf = 1.42 + pull * 0.22;
    var x0 = cx - R * bxf, x1 = cx + R * bxf;
    var y0 = cy - R * bxf, y1 = cy + R * bxf;
    var sx = (x1 - x0) / (Nx - 1), sy = (y1 - y0) / (Ny - 1);

    var need = Nx * Ny;
    if (!E || E.length < need) { E = new Float32Array(need); G = new Float32Array(need); }
    var R2 = R * R;
    var rot = t * 0.11, cr = Math.cos(rot), sr = Math.sin(rot);
    var drift = t * 0.24;

    for (var j = 0; j < Ny; j++) {
      var py = y0 + j * sy;
      for (var i = 0; i < Nx; i++) {
        var px = x0 + i * sx;
        var ax = px - cx, ay = py - cy;
        var Rw2 = R2;
        if (wobble > 0 || pull > 0) {
          var dd = Math.sqrt(ax * ax + ay * ay) + 1e-6;
          var k = 1;
          if (wobble > 0) k += wobble * 0.17 * fbm(ax / dd * 2.3, ay / dd * 2.3, t * 0.55);
          if (pull > 0) {
            // cos of the angle between this point and the pull direction
            var c = (ax * pux + ay * puy) / dd;
            var near = c > 0 ? c * c * c : 0;          // tight lobe toward the pull
            var far = c < 0 ? c * c : 0;               // broad compression opposite
            k += pull * 0.15 * near - pull * 0.06 * far;
          }
          var Rw = R * k;
          Rw2 = Rw * Rw;
        }
        var f = Rw2 / (ax * ax + ay * ay + 1e-6);
        var idx = j * Nx + i;
        G[idx] = f - 1;
        if (f <= 1) { E[idx] = 0; continue; }
        var z = Math.sqrt(1 - 1 / f);
        var nx = ax / R, ny = ay / R;
        var rx = nx * cr - z * sr, rz = nx * sr + z * cr;
        E[idx] = z + amp * fbm(rx * scale, ny * scale, rz * scale + drift);
      }
    }

    // Internal light gathers on the pulled side. A radial gradient centred off
    // the body's middle is enough to read as illumination collecting, and costs
    // one gradient rather than a second pass.
    if (pull > 0.02 && cfg.lightInk) {
      var lx = cx + pux * R * 0.72, ly = cy + puy * R * 0.72;
      var grad = ctx.createRadialGradient(lx, ly, 0, cx, cy, R * 1.7);
      grad.addColorStop(0, cfg.lightInk);
      grad.addColorStop(Math.min(0.9, 0.25 + (1 - pull) * 0.5), ink);
      grad.addColorStop(1, ink);
      ctx.strokeStyle = grad;
    } else {
      ctx.strokeStyle = ink;
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    var step = 1 / density;

    if (!cfg.rimOnly) {
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = topoW;
      ctx.beginPath();
      for (var L = step; L < 1.45; L += step) march(ctx, E, Nx, Ny, x0, y0, sx, sy, L);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = rimW;
    ctx.beginPath();
    march(ctx, G, Nx, Ny, x0, y0, sx, sy, 0);
    ctx.stroke();
  }

  window.ContourSphere = { draw: draw };
})();
