#!/usr/bin/env python3
"""Generate Filenymous PWA PNG icons into ui/public/icons/.

Requires: pip install pillow
Run from repo root or ui/:  python scripts/generate-pwa-icons.py
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError as exc:
    raise SystemExit("Install Pillow: pip install pillow") from exc

ROOT = Path(__file__).resolve().parent.parent / "public" / "icons"
ROOT.mkdir(parents=True, exist_ok=True)


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGBA", (size, size), (9, 9, 11, 255))
    d = ImageDraw.Draw(img)
    cx, cy = size // 2, size // 2
    glow_r = int(size * (0.32 if maskable else 0.38))
    for i in range(6, 0, -1):
        alpha = 18 + i * 6
        d.ellipse(
            [cx - glow_r - i * 2, cy - glow_r - i * 2, cx + glow_r + i * 2, cy + glow_r + i * 2],
            fill=(34, 211, 238, alpha),
        )
    d.ellipse(
        [cx - int(size * 0.18), cy - int(size * 0.02), cx + int(size * 0.12), cy + int(size * 0.22)],
        fill=(255, 255, 255, 255),
    )
    hx, hy = cx + int(size * 0.14), cy - int(size * 0.12)
    hr = int(size * 0.11)
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(255, 255, 255, 255))
    d.polygon(
        [
            (hx + hr - 2, hy - int(size * 0.02)),
            (hx + hr + int(size * 0.08), hy + int(size * 0.01)),
            (hx + hr - 2, hy + int(size * 0.04)),
        ],
        fill=(245, 158, 11, 255),
    )
    er = max(2, int(size * 0.028))
    d.ellipse([hx - er, hy - er - 1, hx + er, hy + er - 1], fill=(15, 23, 42, 255))
    d.ellipse([hx - er // 2 + 1, hy - er - 1, hx + er // 2, hy - 1], fill=(255, 255, 255, 255))
    d.polygon(
        [
            (cx - int(size * 0.05), cy),
            (cx - int(size * 0.28), cy - int(size * 0.18)),
            (cx - int(size * 0.02), cy - int(size * 0.16)),
        ],
        fill=(34, 211, 238, 255),
    )
    sx, sy = cx - int(size * 0.04), cy + int(size * 0.06)
    sw, sh = int(size * 0.09), int(size * 0.08)
    d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=max(2, size // 64), fill=(186, 230, 253, 255))
    d.polygon(
        [
            (cx - int(size * 0.16), cy + int(size * 0.12)),
            (cx - int(size * 0.32), cy + int(size * 0.18)),
            (cx - int(size * 0.28), cy + int(size * 0.24)),
            (cx - int(size * 0.12), cy + int(size * 0.16)),
        ],
        fill=(255, 255, 255, 255),
    )
    return img


def main() -> None:
    sizes = [16, 32, 48, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512]
    for s in sizes:
        name = f"favicon-{s}.png" if s in (16, 32) else f"icon-{s}.png"
        path = ROOT / name
        draw_icon(s).save(path, "PNG")
        print("wrote", path)
    path = ROOT / "icon-maskable-512.png"
    draw_icon(512, maskable=True).save(path, "PNG")
    print("wrote", path)
    # also ensure apple alias
    print("icons ready in", ROOT)


if __name__ == "__main__":
    main()
