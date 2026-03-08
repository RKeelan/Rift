#!/usr/bin/env python3
"""Generate app icons and favicons from source image."""

import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps, ImageDraw

SRC = Path(__file__).parent.parent / "client" / "assets" / "icon-source.png"
OUT = Path(__file__).parent.parent / "client" / "public"

# Accept source path as optional argument
if len(sys.argv) > 1:
    SRC = Path(sys.argv[1])

OUT.mkdir(exist_ok=True)


def make_circular(img: Image.Image) -> Image.Image:
    """Return a copy of img with transparent corners (circular mask)."""
    img = img.convert("RGBA")
    size = img.size
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size[0] - 1, size[1] - 1), fill=255)
    result = img.copy()
    result.putalpha(mask)
    return result


def make_maskable(img: Image.Image, size: int) -> Image.Image:
    """Create a maskable icon: source padded to 80% of canvas, bg fills rest."""
    # Android safe zone: content should fit within inner ~80% circle
    padding_ratio = 0.10  # 10% padding on each side = 80% content area
    pad = int(size * padding_ratio)
    inner_size = size - 2 * pad

    # Resize source to inner content area
    src_resized = img.resize((inner_size, inner_size), Image.LANCZOS)

    # Sample background colour from the corner of the source
    src_full = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    bg_colour = src_full.getpixel((4, 4))

    # Create canvas with background colour
    canvas = Image.new("RGBA", (size, size), bg_colour)
    canvas.paste(src_resized, (pad, pad))
    return canvas


def invert_image(img: Image.Image) -> Image.Image:
    """Invert colours (preserving alpha channel if present)."""
    if img.mode == "RGBA":
        r, g, b, a = img.split()
        rgb = Image.merge("RGB", (r, g, b))
        rgb_inv = ImageOps.invert(rgb)
        r2, g2, b2 = rgb_inv.split()
        return Image.merge("RGBA", (r2, g2, b2, a))
    return ImageOps.invert(img.convert("RGB"))


def stretch_highlights(img: Image.Image, target_bg=(250, 243, 230)) -> Image.Image:
    """Per-channel levels stretch so the background colour maps to target_bg.

    Samples the top-left corner to find the background colour, then linearly
    scales each channel so that value maps to the corresponding target value.
    Dark values scale up only slightly, so the navy areas stay dark.
    """
    arr = np.array(img.convert("RGBA")).astype(float)
    bg = arr[10, 10, :3]  # background colour sampled from corner
    for c in range(3):
        if bg[c] > 0:
            arr[:, :, c] = np.clip(arr[:, :, c] * (target_bg[c] / bg[c]), 0, 255)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def save_ico(img: Image.Image, path: Path) -> None:
    """Save image as .ico with multiple sizes embedded."""
    sizes = [16, 32, 48]
    imgs = [img.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[0].save(path, format="ICO", sizes=[(s, s) for s in sizes],
                 append_images=imgs[1:])


src = Image.open(SRC).convert("RGBA")

# ── Standard icons (light mode) ─────────────────────────────────────────────
for size, name in [(192, "icon-192.png"), (512, "icon-512.png")]:
    resized = src.resize((size, size), Image.LANCZOS)
    resized.save(OUT / name)
    print(f"  wrote {name}")

# ── Maskable icons (light mode, for Android adaptive icons) ─────────────────
for size, name in [(192, "icon-192-maskable.png"), (512, "icon-512-maskable.png")]:
    maskable = make_maskable(src, size)
    maskable.save(OUT / name)
    print(f"  wrote {name}")

# ── Dark mode icons ──────────────────────────────────────────────────────────
src_dark = stretch_highlights(invert_image(src))

for size, name in [(192, "icon-192-dark.png"), (512, "icon-512-dark.png")]:
    resized = src_dark.resize((size, size), Image.LANCZOS)
    resized.save(OUT / name)
    print(f"  wrote {name}")

# ── Favicons (circular / transparent corners) ────────────────────────────────
fav_size = 512

fav_light = make_circular(src.resize((fav_size, fav_size), Image.LANCZOS))
save_ico(fav_light, OUT / "favicon.ico")
print("  wrote favicon.ico")

fav_dark = make_circular(src_dark.resize((fav_size, fav_size), Image.LANCZOS))
save_ico(fav_dark, OUT / "favicon-dark.ico")
print("  wrote favicon-dark.ico")

# Also write a hi-res circular PNG for apple-touch-icon etc.
fav_light_180 = make_circular(src.resize((180, 180), Image.LANCZOS))
fav_light_180.save(OUT / "apple-touch-icon.png")
print("  wrote apple-touch-icon.png")

print("\nDone.")
