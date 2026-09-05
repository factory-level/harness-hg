# Generates the platform's placeholder avatar inventory (#426).
#
# Run:  uv run --with pillow python infra/scripts/gen-avatars.py
#
# Every asset in control-plane/nexus/avatars/ is produced by this script -
# generated in-repo, so the license question has a one-word answer (ours)
# and a regeneration is a command, not an archaeology dig. Deterministic:
# all geometry derives from the avatar's id, so the same id always draws
# the same bot. Real brand art replaces these one file at a time; the
# serving contract (512KB, 256px, square) is what it must fit, not this
# script.

from __future__ import annotations

import hashlib
import struct
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "dashboard" / "nexus" / "avatars"
GRID = 16  # design grid; scaled x8 -> 128px
SCALE = 8
FRAMES = 4

# One hue family per bot keeps the inventory legible at a glance.
BOTS = {
    "bot-atlas": (208, 82),   # steel blue
    "bot-bolt": (48, 96),     # amber
    "bot-comet": (16, 88),    # ember
    "bot-dune": (36, 70),     # sand
    "bot-echo": (280, 74),    # violet
    "bot-fern": (130, 66),    # leaf
    "bot-luna": (250, 60),    # dusk
    "bot-nova": (330, 80),    # magenta
    "bot-pixel": (190, 78),   # cyan
    "bot-quill": (100, 55),   # moss
    "bot-rune": (0, 72),      # crimson
    "bot-vega": (160, 72),    # teal
}


def rng(seed: str):
    """Tiny deterministic byte stream off sha256 - no random module, no
    platform drift."""
    buf = b""
    counter = 0
    while True:
        if not buf:
            buf = hashlib.sha256(f"{seed}:{counter}".encode()).digest()
            counter += 1
        b, buf = buf[0], buf[1:]
        yield b


def hsl(h: float, s: float, l: float) -> tuple[int, int, int]:
    s /= 100
    l /= 100
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    r, g, b = {0: (c, x, 0), 1: (x, c, 0), 2: (0, c, x), 3: (0, x, c), 4: (x, 0, c), 5: (c, 0, x)}[int(h // 60) % 6]
    return tuple(round((v + m) * 255) for v in (r, g, b))


def draw(bot: str, hue: int, sat: int) -> list[Image.Image]:
    r = rng(bot)
    body = hsl(hue, sat, 52)
    dark = hsl(hue, sat, 34)
    lite = hsl(hue, min(100, sat + 10), 72)
    eye = hsl(hue, 30, 12)

    head_w = 8 + next(r) % 3 * 2          # 8|10|12
    head_h = 5 + next(r) % 2              # 5|6
    eye_dx = 1 + next(r) % 2              # eye inset
    antenna = next(r) % 3                 # 0 none | 1 single | 2 twin
    ear = next(r) % 2                     # side nubs
    blink_frame = 2 + next(r) % 2         # which frame blinks

    frames = []
    for f in range(FRAMES):
        bob = (0, 1, 0, -1)[f]            # subtle vertical loop
        px = {}

        def rect(x0, y0, w, h, col):
            for x in range(x0, x0 + w):
                for y in range(y0, y0 + h):
                    if 0 <= x < GRID and 0 <= y < GRID:
                        px[(x, y)] = col

        hx = (GRID - head_w) // 2
        hy = 3 + bob
        # head + face plate
        rect(hx, hy, head_w, head_h, body)
        rect(hx + 1, hy + 1, head_w - 2, head_h - 2, lite)
        # eyes (blink on one frame)
        ey = hy + head_h // 2 - (0 if f == blink_frame else 1)
        eh = 1 if f == blink_frame else 2
        rect(hx + 1 + eye_dx, ey, 2, eh, eye)
        rect(hx + head_w - 3 - eye_dx, ey, 2, eh, eye)
        # antenna
        if antenna:
            tips = [GRID // 2] if antenna == 1 else [hx + 1, hx + head_w - 2]
            for tx in tips:
                rect(tx, hy - 2, 1, 2, dark)
                rect(tx, hy - 3 + (f % 2), 1, 1, lite)
        # ears
        if ear:
            rect(hx - 1, hy + 2, 1, 2, dark)
            rect(hx + head_w, hy + 2, 1, 2, dark)
        # body + belly light that walks the frames
        bw = head_w - 2
        bx = (GRID - bw) // 2
        by = hy + head_h + 1
        rect(bx, by, bw, 4, body)
        rect(bx + 1 + f % max(1, bw - 3), by + 1, 1, 2, lite)
        # feet
        rect(bx, by + 4, 2, 1, dark)
        rect(bx + bw - 2, by + 4, 2, 1, dark)

        img = Image.new("RGBA", (GRID * SCALE, GRID * SCALE), (0, 0, 0, 0))
        for (x, y), col in px.items():
            for sx in range(SCALE):
                for sy in range(SCALE):
                    img.putpixel((x * SCALE + sx, y * SCALE + sy), (*col, 255))
        frames.append(img)
    return frames


def save_gif(path: Path, frames: list[Image.Image]) -> None:
    # Exact shared palette, index 0 reserved transparent - ADAPTIVE
    # quantization scrambles hues on tiny palettes with alpha.
    colors: list[tuple[int, int, int]] = []
    for f in frames:
        for _, c in f.getcolors(maxcolors=4096):
            if c[3] and c[:3] not in colors:
                colors.append(c[:3])
    palette = [0, 0, 0] + [v for c in colors for v in c]
    pal_frames = []
    for f in frames:
        p = Image.new("P", f.size, 0)
        p.putpalette(palette + [0] * (768 - len(palette)))
        for x in range(f.width):
            for y in range(f.height):
                c = f.getpixel((x, y))
                if c[3]:
                    p.putpixel((x, y), colors.index(c[:3]) + 1)
        pal_frames.append(p)
    pal_frames[0].save(
        path,
        save_all=True,
        append_images=pal_frames[1:],
        duration=420,
        loop=0,
        transparency=0,
        disposal=2,
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for bot, (hue, sat) in sorted(BOTS.items()):
        frames = draw(bot, hue, sat)
        out = OUT / f"{bot}.gif"
        save_gif(out, frames)
        # A single-frame twin for reduced-motion (#426 beta pass, spec
        # §15/16): same stem grammar plus "-still", still passes the
        # serve-time _ICON_ID_RE, so no route change is needed.
        still = OUT / f"{bot}-still.gif"
        save_gif(still, frames[:1])
        for path in (out, still):
            w, h = Image.open(path).size
            size = path.stat().st_size
            assert w == h <= 256 and size <= 512 * 1024, (path.name, w, h, size)
            print(f"{path.name}: {w}x{h}, {size} bytes")


if __name__ == "__main__":
    main()
