#!/usr/bin/env -S uv --quiet run --frozen --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""Turn reviewed artwork into the files the plugin ships. Deterministic, no Codex.

usage: finalize-assets.py [--icon RAW.png] [--previews] [--check]

  --icon RAW.png   a reviewed raw icon (from assets/rendered/) becomes the committed
                   source assets/final/plugin-icon-source.png (1024x1024, opaque).
                   Without it, the existing source is used.
  --previews       copy the reviewed tile-*.svg from assets/rendered/ to
                   assets/final/previews/ and export 144x144 PNGs.
  --check          only verify the committed outputs (sizes, opacity, monochrome)
                   and exit 1 on any defect.

Always (re)generated from committed sources:
  <plugin>/imgs/plugin/plugin-icon.png        256x256, opaque
  <plugin>/imgs/plugin/plugin-icon@2x.png     512x512, opaque
  <plugin>/imgs/plugin/category-icon.png      28x28,   white on transparent
  <plugin>/imgs/plugin/category-icon@2x.png   56x56,   white on transparent

The category icon is the Lucide "cloud-sun" glyph (ISC licence, from the
lucide-static dev dependency), recoloured to #FFFFFF and rasterised with
ImageMagick. The plugin icon is AI-generated original artwork, see docs/RENDERING.md.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_IMGS = os.path.join(ROOT, "de.schwetschke.sd.home-weather-station.sdPlugin", "imgs", "plugin")
FINAL = os.path.join(ROOT, "assets", "final")
RENDERED = os.path.join(ROOT, "assets", "rendered")
ICON_SOURCE = os.path.join(FINAL, "plugin-icon-source.png")
PREVIEWS = os.path.join(FINAL, "previews")
LUCIDE = os.path.join(ROOT, "node_modules", "lucide-static", "icons", "cloud-sun.svg")
MAGICK = shutil.which("magick") or "magick"

ICON_OUTPUTS = {"plugin-icon.png": 256, "plugin-icon@2x.png": 512}
CATEGORY_OUTPUTS = {"category-icon.png": 28, "category-icon@2x.png": 56}


def magick(*args):
    r = subprocess.run([MAGICK, *args], capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(f"magick {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def identify(path, fmt):
    return magick("identify", "-format", fmt, path).strip()


def publish(tmp, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    os.replace(tmp, dest)  # tmp lives in the same directory: atomic


def make_icon_source(raw):
    """Reviewed raw PNG -> opaque 1024x1024 sRGB source (metadata stripped)."""
    tmp = f"{ICON_SOURCE}.tmp.{os.getpid()}"
    os.makedirs(FINAL, exist_ok=True)
    magick(raw, "-alpha", "off", "-resize", "1024x1024!", "-strip", "-colorspace", "sRGB", f"PNG24:{tmp}")
    publish(tmp, ICON_SOURCE)


def make_plugin_icons():
    for name, size in ICON_OUTPUTS.items():
        dest = os.path.join(PLUGIN_IMGS, name)
        tmp = f"{dest}.tmp.{os.getpid()}"
        os.makedirs(PLUGIN_IMGS, exist_ok=True)
        # Lanczos downscale from the 1024 source; opaque RGB, no metadata.
        magick(ICON_SOURCE, "-filter", "Lanczos", "-resize", f"{size}x{size}!", "-alpha", "off", "-strip", f"PNG24:{tmp}")
        publish(tmp, dest)


def white_glyph_svg(text):
    """Lucide draws with currentColor strokes; pin them to white."""
    out = text.replace("currentColor", "#FFFFFF")
    out = re.sub(r"\sclass=\"[^\"]*\"", "", out)
    return out


def make_category_icons():
    with open(LUCIDE, encoding="utf-8") as f:
        svg = white_glyph_svg(f.read())
    with tempfile.TemporaryDirectory(prefix="finalize.") as d:
        src = os.path.join(d, "glyph.svg")
        with open(src, "w", encoding="utf-8") as f:
            f.write(svg)
        for name, size in CATEGORY_OUTPUTS.items():
            dest = os.path.join(PLUGIN_IMGS, name)
            tmp = f"{dest}.tmp.{os.getpid()}"
            os.makedirs(PLUGIN_IMGS, exist_ok=True)
            raster, mask = os.path.join(d, "r.png"), os.path.join(d, "m.png")
            # High density first, then downscale: crisper than rendering at 28 px directly.
            magick("-background", "none", "-density", "1536", src, "-resize", f"{size}x{size}!", raster)
            # Keep only the coverage; colour is forced to pure white so the file is
            # exactly "#FFFFFF on transparent" as the manifest docs require.
            magick(raster, "-alpha", "extract", mask)
            magick("-size", f"{size}x{size}", "xc:white", mask, "-compose", "CopyOpacity", "-composite", "-strip", f"PNG32:{tmp}")
            publish(tmp, dest)


def make_previews():
    srcs = sorted(f for f in os.listdir(RENDERED) if re.fullmatch(r"tile-[a-z0-9-]+\.svg", f)) if os.path.isdir(RENDERED) else []
    if not srcs:
        raise RuntimeError("no assets/rendered/tile-*.svg; run `npm run render` first")
    os.makedirs(PREVIEWS, exist_ok=True)
    for f in srcs:
        base = f[:-4]
        shutil.copyfile(os.path.join(RENDERED, f), os.path.join(PREVIEWS, f))
        tmp = os.path.join(PREVIEWS, f"{base}.png.tmp.{os.getpid()}")
        magick("-background", "none", os.path.join(PREVIEWS, f), "-resize", "144x144!", "-strip", f"PNG32:{tmp}")
        publish(tmp, os.path.join(PREVIEWS, f"{base}.png"))
    return srcs


def check():
    """Return a list of defects in the committed outputs."""
    bad = []
    for name, size in ICON_OUTPUTS.items():
        p = os.path.join(PLUGIN_IMGS, name)
        if not os.path.isfile(p):
            bad.append(f"{name}: missing")
            continue
        if identify(p, "%wx%h") != f"{size}x{size}":
            bad.append(f"{name}: size {identify(p, '%wx%h')}, expected {size}x{size}")
        if identify(p, "%[opaque]").lower() != "true":
            bad.append(f"{name}: not fully opaque")
    for name, size in CATEGORY_OUTPUTS.items():
        p = os.path.join(PLUGIN_IMGS, name)
        if not os.path.isfile(p):
            bad.append(f"{name}: missing")
            continue
        if identify(p, "%wx%h") != f"{size}x{size}":
            bad.append(f"{name}: size {identify(p, '%wx%h')}, expected {size}x{size}")
        txt = magick(p, "txt:-")
        # First tuple per line only: later ones repeat it in other notations.
        found = (re.search(r": \((\d+),(\d+),(\d+),(\d+)\)", line) for line in txt.splitlines()[1:])
        pix = [m.groups() for m in found if m]
        if len(pix) != size * size:
            bad.append(f"{name}: could not read {size * size} pixels (got {len(pix)})")
            continue
        if not any(int(a) == 0 for *_c, a in pix) or not any(int(a) > 0 for *_c, a in pix):
            bad.append(f"{name}: no transparent or no visible pixels")
        if any((int(r), int(g), int(b)) != (255, 255, 255) for r, g, b, a in pix if int(a) > 0):
            bad.append(f"{name}: visible pixels that are not pure white")
    for f in ("plugin-icon-source.png",):
        p = os.path.join(FINAL, f)
        if not os.path.isfile(p):
            bad.append(f"assets/final/{f}: missing")
        elif identify(p, "%wx%h") != "1024x1024":
            bad.append(f"assets/final/{f}: not 1024x1024")
    if os.path.isdir(PREVIEWS):
        for f in sorted(os.listdir(PREVIEWS)):
            if f.endswith(".png") and identify(os.path.join(PREVIEWS, f), "%wx%h") != "144x144":
                bad.append(f"previews/{f}: not 144x144")
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--icon", help="reviewed raw icon PNG that becomes the committed source")
    ap.add_argument("--previews", action="store_true", help="refresh assets/final/previews from assets/rendered")
    ap.add_argument("--check", action="store_true", help="verify committed outputs only")
    args = ap.parse_args()
    if shutil.which("magick") is None:
        print("error: ImageMagick (`magick`) not found on PATH", file=sys.stderr)
        return 2
    if not args.check:
        if args.icon:
            make_icon_source(args.icon)
            print(f"icon source <- {args.icon}")
        if os.path.isfile(ICON_SOURCE):
            make_plugin_icons()
            print("plugin icons: 256 + 512")
        make_category_icons()
        print("category icons: 28 + 56")
        if args.previews:
            print(f"previews: {', '.join(make_previews())}")
    bad = check()
    for b in bad:
        print(f"DEFECT {b}", file=sys.stderr)
    print("assets ok" if not bad else f"{len(bad)} defect(s)", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
