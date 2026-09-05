# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "numpy>=1.26", "scipy>=1.12", "imageio>=2.34", "imageio-ffmpeg>=0.5", "fastapi>=0.110"]
# ///
"""Key Higgsfield avatar videos into transparent animated WebP.

The sources are 960x960 pixel-art dioramas on a dark navy vignette that
sits only ~14-16 from the art's OWN near-blacks, so pure colour keying
is unsolvable: any tolerance wide enough to clear the ground also eats
dark hair, suits and the contour ring. Two earlier pipelines shipped
exactly that defect. The fix is to decide the silhouette from two
independent sources whose failure modes are opposites, and UNION them:

  * a semantic matte (Higgsfield `image_background_remover`, run once per
    avatar on the temporal median frame - 1 credit) keeps dark hair and
    suits perfectly, but fades the stone floor platform out, reading it
    as ground rather than object;
  * a gradient-following border flood keeps every bright built structure
    (floor slabs, desks, boards) crisply, and eats the near-blacks.

A union can only ADD opacity, so neither model's over-cutting survives
and no art either one kept is lost. See `scene_mask`.

The mask is constant across frames (locked camera, idle-scale motion),
and RGB always comes from the untouched original frame, so the shipped
art is exactly what was generated. Then: temporal stabilization freezes
codec shimmer, one shared 255-colour palette keeps the pixel-art flat
and the lossless encode under the serve cap, and the premultiplied BOX
downscale 960->128 turns the binary mask into the 8-bit antialiased
edge. Animated WebP at 8fps plus a still twin; stills are rewrapped
into the VP8X layout - the only one plugin_api serves. Every output is
checked against the real serve-time gate (avatar_asset_error).

Usage:
  # 1. one matte per avatar, from its median frame (1 credit each):
  higgsfield generate create image_background_remover --image <role>-median.png
  # 2. key:
  uv run infra/scripts/rekey-avatars.py \
      --sources <dir-of-role.mp4> --mattes <dir-of-role.png> \
      --out control-plane/nexus/avatars [--roles ceo,security]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import imageio.v3 as iio
import numpy as np
from PIL import Image
from scipy import ndimage

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "dashboard" / "nexus"))
from plugin_api import avatar_asset_error  # noqa: E402  (the exact serve gate)

OUT_SIZE = 128
FRAME_STEP = 3          # 24fps source -> 8fps output
FRAME_MS = 125          # 8fps
STEP_TOL = 10.0         # per-step Euclidean colour distance; outline step is ~14-16
SEED_TOL = 30.0         # border seed must sit near the median border colour
EDGE_RING = 8           # px at 960: the frame edge is background by construction
OPEN_ITERS = 5          # anti-leak: drop background tendrils thinner than ~11px
CLOSE_ITERS = 2         # background-mask close radius (codec notches)
MATTE_TOL = 8           # alpha at/above which the semantic matte claims a pixel;
                        # deliberately low - the matte fades the floor platform
                        # out rather than cutting it, and the union below only
                        # ever ADDS opacity, so a generous read costs nothing
SPECK_MAX = 400         # px at 960: smaller detached fg islands are dither
STAB_TOL = 10           # per-channel inter-frame delta that is codec noise


def _flood_background(frame: np.ndarray) -> np.ndarray:
    """Border-connected background via gradient-following flood.

    Geometry only: a pixel with a colour step > STEP_TOL to a 4-neighbour
    is a cut, the rest form components joined through smooth gradient, and
    background is what a border seed near the median border colour reaches.
    Strong on the bright built structures (floor slabs, desks, boards);
    weak exactly where art and ground share a near-black, which is why it
    is unioned with the semantic matte rather than trusted alone.
    """
    f = frame.astype(np.float32)
    dy = np.sqrt(((f[1:, :] - f[:-1, :]) ** 2).sum(-1))
    dx = np.sqrt(((f[:, 1:] - f[:, :-1]) ** 2).sum(-1))
    cut = np.zeros(f.shape[:2], dtype=bool)
    cut[1:, :] |= dy > STEP_TOL
    cut[:-1, :] |= dy > STEP_TOL
    cut[:, 1:] |= dx > STEP_TOL
    cut[:, :-1] |= dx > STEP_TOL

    labels, _ = ndimage.label(~cut)  # 4-connectivity
    border = np.concatenate([f[0], f[-1], f[:, 0], f[:, -1]])
    med = np.median(border, axis=0)
    near_med = np.sqrt(((f - med) ** 2).sum(-1)) <= SEED_TOL
    seed = np.zeros_like(cut)
    seed[0, :] = seed[-1, :] = seed[:, 0] = seed[:, -1] = True
    bg = np.isin(labels, np.unique(labels[seed & near_med & (labels > 0)]))

    bg[:EDGE_RING, :] = bg[-EDGE_RING:, :] = True
    bg[:, :EDGE_RING] = bg[:, -EDGE_RING:] = True
    bg = ndimage.binary_opening(bg, iterations=OPEN_ITERS)
    bg = ndimage.binary_closing(bg, iterations=CLOSE_ITERS)
    bg[:EDGE_RING, :] = bg[-EDGE_RING:, :] = True
    bg[:, :EDGE_RING] = bg[:, -EDGE_RING:] = True
    labels, _ = ndimage.label(bg)
    edge_ids = np.unique(
        np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    )
    return np.isin(labels, edge_ids[edge_ids > 0])


def _fill_enclosed(fg: np.ndarray) -> np.ndarray:
    """Transparency must reach the frame border to be background."""
    labels, _ = ndimage.label(~fg)
    edge_ids = np.unique(
        np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    )
    return ~np.isin(labels, edge_ids[edge_ids > 0])


def scene_mask(median_frame: np.ndarray, matte_alpha: np.ndarray) -> np.ndarray:
    """The avatar's ONE opaque region: semantic matte UNION geometric flood.

    Neither source is sufficient alone, and their failures are opposites:

      * the flood eats the art's own near-blacks (dark hair, suits, the
        contour ring) wherever they touch the near-black ground - the
        defect two earlier pipelines shipped;
      * the semantic matte keeps those perfectly, but fades away the
        stone floor platform, reading it as ground rather than object.

    A UNION is the safe combination: it can only ADD opacity, so neither
    model's over-cutting can survive it, and no art either one kept can
    be lost. What remains is despeckled and hole-filled.
    """
    fg = (~_flood_background(median_frame)) | (matte_alpha >= MATTE_TOL)
    return _fill_enclosed(_despeckle(fg))


def _despeckle(fg: np.ndarray) -> np.ndarray:
    """Drop foreground islands too small to be art (detached shadow dither)."""
    labels, n = ndimage.label(fg)
    if n == 0:
        return fg
    sizes = ndimage.sum_labels(fg, labels, np.arange(1, n + 1))
    keep = np.flatnonzero(sizes > SPECK_MAX) + 1
    return np.isin(labels, keep)


def key_frame(frame: np.ndarray, mask: np.ndarray) -> Image.Image:
    """One 960px RGB frame + the scene mask -> 128px RGBA.

    The mask is constant across frames: the camera is locked and the
    motion is idle-scale, so a per-frame decision buys nothing and costs
    edge shimmer. RGB comes from the untouched original frame, so the art
    is exactly what Higgsfield drew.
    """
    a = mask.astype(np.float32)
    rgb = frame.astype(np.float32) * a[..., None]  # premultiply
    big = np.dstack([rgb, a * 255.0]).astype(np.uint8)
    im = Image.fromarray(big, "RGBA").resize(
        (OUT_SIZE, OUT_SIZE), Image.Resampling.BOX
    )
    out = np.asarray(im).astype(np.float32)
    alpha = out[..., 3:4]
    un = np.where(alpha > 0, out[..., :3] * 255.0 / np.maximum(alpha, 1), 0)
    return Image.fromarray(
        np.dstack([np.clip(un, 0, 255), alpha[..., 0]]).astype(np.uint8), "RGBA"
    )


def _vp8x_wrap(data: bytes) -> bytes:
    """Rewrap a bare VP8L/VP8 still in the VP8X extended layout.

    plugin_api serves only VP8X WebP, and encoders collapse a still (or
    identical duplicate frames) to the simple layout no matter how the
    input is arranged - so build the extended container ourselves: same
    image chunk, plus the fixed 10-byte VP8X header (alpha flag, canvas
    size), which is exactly what the serve gate parses.
    """
    if data[12:16] == b"VP8X":
        return data
    payload = data[12:]
    vp8x = (
        b"VP8X"
        + (10).to_bytes(4, "little")
        + bytes([0x10, 0, 0, 0])  # alpha flag
        + (OUT_SIZE - 1).to_bytes(3, "little")
        + (OUT_SIZE - 1).to_bytes(3, "little")
    )
    return (
        b"RIFF"
        + (4 + len(vp8x) + len(payload)).to_bytes(4, "little")
        + b"WEBP"
        + vp8x
        + payload
    )


def _save_webp(path: Path, frames: list[Image.Image]) -> None:
    """Encode RGBA frames as animated WebP through ffmpeg's libwebp_anim.

    NOT Pillow: its animated-WebP encoder pre-blends every frame over an
    opaque white background, silently destroying the alpha channel the
    whole pipeline exists to produce.
    """
    import imageio_ffmpeg

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    raw = b"".join(np.asarray(f.convert("RGBA")).tobytes() for f in frames)
    for tier in (
        ["-lossless", "1", "-compression_level", "6", "-q:v", "100", "-pix_fmt", "bgra"],
        ["-lossless", "0", "-q:v", "95", "-pix_fmt", "yuva420p"],
        ["-lossless", "0", "-q:v", "85", "-pix_fmt", "yuva420p"],
    ):
        cmd = [
            exe, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "rgba",
            "-s", f"{OUT_SIZE}x{OUT_SIZE}", "-r", str(1000 // FRAME_MS),
            "-i", "-",
            "-c:v", "libwebp_anim", *tier, "-loop", "0",
            str(path),
        ]
        proc = subprocess.run(cmd, input=raw, capture_output=True)
        if proc.returncode != 0:
            raise SystemExit(f"{path.name}: ffmpeg failed: {proc.stderr.decode()}")
        path.write_bytes(_vp8x_wrap(path.read_bytes()))
        err = avatar_asset_error(".webp", path.read_bytes())
        if err is None:
            return
        if "cap" not in err:
            raise SystemExit(f"{path.name}: {err}")
    raise SystemExit(f"{path.name}: exceeds the byte cap at every quality tier")


def _stabilize(keyed: list[Image.Image]) -> list[Image.Image]:
    """Freeze pixels whose inter-frame change is only codec noise.

    h264 shimmer makes every static pixel drift a little every frame,
    which both shimmers on screen and makes lossless animation frames
    incompressible. Below the threshold, a pixel repeats the previous
    frame's value exactly - static regions become bit-identical.
    """
    stack = [np.asarray(f).astype(np.int16) for f in keyed]
    for t in range(1, len(stack)):
        calm = np.abs(stack[t] - stack[t - 1]).max(axis=-1) <= STAB_TOL
        stack[t][calm] = stack[t - 1][calm]
    return [Image.fromarray(s.astype(np.uint8), "RGBA") for s in stack]


def _quantize(keyed: list[Image.Image]) -> list[Image.Image]:
    """One shared 255-colour palette across every frame, alpha untouched.

    The ADR-146 GIFs' shared-palette discipline, kept for WebP: the flat
    pixel-art look wants few colours anyway, palette flicker between
    frames wants exactly one palette, and VP8L's palette mode is what
    brings a 41-frame lossless animation under the 512KB serve cap.
    """
    sheet = Image.new("RGB", (OUT_SIZE * len(keyed), OUT_SIZE))
    for i, f in enumerate(keyed):
        sheet.paste(f.convert("RGB"), (i * OUT_SIZE, 0))
    pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    out = []
    for f in keyed:
        rgb = f.convert("RGB").quantize(palette=pal, dither=Image.Dither.NONE)
        q = rgb.convert("RGBA")
        q.putalpha(f.getchannel("A"))
        out.append(q)
    return out


def process(video: Path, out_dir: Path, role: str, matte: Path) -> None:
    frames = iio.imread(video)
    picked = frames[::FRAME_STEP]
    median = np.median(picked, axis=0).astype(np.uint8)
    matte_alpha = np.asarray(Image.open(matte).convert("RGBA"))[..., 3]
    if matte_alpha.shape != median.shape[:2]:
        raise SystemExit(f"{role}: matte is {matte_alpha.shape}, video {median.shape[:2]}")
    mask = scene_mask(median, matte_alpha)
    keyed = _quantize(_stabilize([key_frame(f, mask) for f in picked]))

    anim = out_dir / f"{role}.webp"
    still = out_dir / f"{role}-still.webp"
    _save_webp(anim, keyed)
    _save_webp(still, [keyed[0]])  # _vp8x_wrap upgrades the bare still
    print(
        f"{role}: {len(keyed)} frames, "
        f"{anim.stat().st_size:,} B anim / {still.stat().st_size:,} B still"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sources", type=Path, required=True,
                    help="dir of raw <role>.mp4 generations")
    ap.add_argument("--mattes", type=Path, required=True,
                    help="dir of <role>.png RGBA cutouts from image_background_remover")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--roles", help="comma-separated subset (default: every *.mp4)")
    args = ap.parse_args()

    videos = sorted(args.sources.glob("*.mp4"))
    if args.roles:
        want = set(args.roles.split(","))
        videos = [v for v in videos if v.stem in want]
    if not videos:
        raise SystemExit("no source videos matched")
    args.out.mkdir(parents=True, exist_ok=True)
    for v in videos:
        matte = args.mattes / f"{v.stem}.png"
        if not matte.is_file():
            raise SystemExit(f"{v.stem}: no matte at {matte}")
        process(v, args.out, v.stem, matte)


if __name__ == "__main__":
    main()
