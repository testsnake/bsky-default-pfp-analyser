#!/usr/bin/env python3
"""
SVG Overlap Analyzer
--------------------
Rasterizes every SVG in a folder and produces an output image where:
  - Bright white  = pixels that are filled in ALL SVGs  (full overlap)
  - Gradient grey = pixels filled in SOME SVGs          (partial overlap)
  - Black         = pixels that are empty in every SVG  (no overlap)

Usage:
    python svg_overlap.py <folder> [output.png] [--size N]
"""

import argparse
import sys
from pathlib import Path

import cairosvg
import numpy as np
from PIL import Image
import io


def svg_to_alpha(svg_path: Path, size: int) -> np.ndarray:
    """Rasterise an SVG and return a float32 alpha mask (0.0–1.0)."""
    png_bytes = cairosvg.svg2png(
        url=str(svg_path),
        output_width=size,
        output_height=size,
    )
    img = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    arr = np.array(img, dtype=np.float32)
    # alpha channel tells us where the icon has actual pixels
    return arr[:, :, 3] / 255.0


def build_overlap_image(folder: Path, output: Path, size: int) -> None:
    svg_files = sorted(folder.glob("*.svg"))
    if not svg_files:
        print(f"No SVG files found in '{folder}'")
        sys.exit(1)

    print(f"Found {len(svg_files)} SVG files:")
    for f in svg_files:
        print(f"  {f.name}")

    # Accumulate alpha masks
    total = np.zeros((size, size), dtype=np.float32)
    for svg_path in svg_files:
        alpha = svg_to_alpha(svg_path, size)
        # Treat any pixel with alpha > 0 as "filled" for that icon
        filled = (alpha > 0.1).astype(np.float32)
        total += filled

    n = len(svg_files)

    # --- Overlap image ---
    # Value = fraction of SVGs that cover this pixel  (0.0 → 1.0)
    fraction = total / n

    # Map to a nice colour gradient:
    #   0   SVGs → deep navy   (#0d1117)
    #   50% SVGs → electric violet (#7c3aed)
    #   100% SVGs → bright white (#ffffff)
    def lerp(a, b, t):
        return a + (b - a) * t

    c_none  = np.array([13,  17, 23],  dtype=np.float32)   # deep navy
    c_mid   = np.array([124, 58, 237], dtype=np.float32)   # electric violet
    c_full  = np.array([255, 255, 255], dtype=np.float32)  # white

    f = fraction[:, :, np.newaxis]  # (H, W, 1)

    # Two-stop gradient
    lower_mask = (f < 0.5)
    t_low  = f / 0.5          # 0→1 for fraction 0→0.5
    t_high = (f - 0.5) / 0.5  # 0→1 for fraction 0.5→1.0

    rgb = np.where(
        lower_mask,
        lerp(c_none, c_mid, t_low),
        lerp(c_mid,  c_full, t_high),
    ).clip(0, 255).astype(np.uint8)

    result_img = Image.fromarray(rgb, mode="RGB")

    # --- Side-by-side: thumbnails + overlap ---
    thumb = size // 4
    cols  = min(6, n)
    rows  = (n + cols - 1) // cols

    strip_w = thumb * cols
    strip_h = thumb * rows
    strip   = Image.new("RGB", (strip_w, strip_h), (20, 20, 30))

    for i, svg_path in enumerate(svg_files):
        alpha = svg_to_alpha(svg_path, thumb)
        # White icon on dark background for thumbnail
        icon_rgba = np.zeros((thumb, thumb, 4), dtype=np.uint8)
        icon_rgba[:, :, :3] = 255
        icon_rgba[:, :, 3]  = (alpha * 255).astype(np.uint8)
        icon_img = Image.fromarray(icon_rgba, "RGBA")
        bg = Image.new("RGB", (thumb, thumb), (30, 30, 46))
        bg.paste(icon_img, mask=icon_img.split()[3])
        col = i % cols
        row = i // cols
        strip.paste(bg, (col * thumb, row * thumb))

    # Assemble final canvas: thumbnails on top, big overlap below
    canvas_w = max(strip_w, size)
    canvas_h = strip_h + size + 20
    canvas = Image.new("RGB", (canvas_w, canvas_h), (13, 17, 23))
    canvas.paste(strip, ((canvas_w - strip_w) // 2, 0))
    canvas.paste(result_img, ((canvas_w - size) // 2, strip_h + 20))

    canvas.save(output)
    print(f"\nOverlap image saved → {output}")
    print(f"Canvas size: {canvas.width}×{canvas.height} px")

    # Print some stats
    print(f"\nOverlap stats (at {size}×{size}):")
    for label, lo, hi in [
        ("No overlap   (0 SVGs)",    0,       0),
        ("Low overlap  (1-25%)",      1,      n * 0.25),
        ("Mid overlap  (25-75%)",  n * 0.25, n * 0.75),
        ("High overlap (75-99%)", n * 0.75,  n - 1),
        ("Full overlap (ALL SVGs)",  n,       n),
    ]:
        count = int(np.sum((total >= lo) & (total <= hi)))
        pct = count / (size * size) * 100
        print(f"  {label}: {count:6d} px ({pct:.1f}%)")


def main():
    parser = argparse.ArgumentParser(description="Visualise pixel overlap across SVG icons.")
    parser.add_argument("folder", nargs="?", default=".",
                        help="Folder containing SVG files (default: current dir)")
    parser.add_argument("output", nargs="?", default="overlap.png",
                        help="Output PNG path (default: overlap.png)")
    parser.add_argument("--size", type=int, default=512,
                        help="Rasterisation size in pixels (default: 512)")
    args = parser.parse_args()

    build_overlap_image(
        folder=Path(args.folder),
        output=Path(args.output),
        size=args.size,
    )


if __name__ == "__main__":
    main()