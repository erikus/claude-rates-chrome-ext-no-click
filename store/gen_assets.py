# Generates the static Web Store assets:
#   icons/icon{16,48}.png   - manifest icons, full-bleed like the runtime icon
#   icons/icon128.png       - manifest + store icon: 96x96 artwork centered in
#                             a 128x128 canvas with 16 px transparent padding,
#                             per the Web Store icon guidelines
#   store/screenshot-*.png  - store listing screenshots (1280x800), made by
#                             centering real screenshots from store/src/ on a
#                             neutral background
#
# Run from the repo root:  uv run --with pillow store/gen_assets.py
#
# The icon drawing is a port of drawIcon() in background.js. Keep the geometry
# constants in sync with that file if they change there.

from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
ICONS_DIR = REPO / "icons"
STORE_DIR = REPO / "store"
SRC_DIR = STORE_DIR / "src"

# --- Geometry, mirrored from background.js ---------------------------------
ICON_BASE_SIZE = 16
ICON_BOTTOM_INSET_DIP = 1
ICON_CORNER_RADIUS_DIP = 1
ICON_BAR_GAP_FRACTION = 0.1
ICON_MIN_FILL_FRACTION = 0.08
ICON_BACKGROUND_ALPHA = 0.25
EMPHASIZED_INDEX = 2  # Fable

COLOR_ON_PACE = (0x2E, 0x9E, 0x5B)
COLOR_UNDER_PACE = (0x3B, 0x82, 0xF6)
COLOR_OVER_PACE = (0xD9, 0xA4, 0x00)
COLOR_TRACK = (128, 128, 128, int(0.35 * 255))

# --- Store icon ------------------------------------------------------------
STORE_ICON_CANVAS = 128
STORE_ICON_ARTWORK = 96
STORE_ICON_PADDING = (STORE_ICON_CANVAS - STORE_ICON_ARTWORK) // 2
FULL_BLEED_ICON_SIZES = (16, 48)
# One bucket per pace color: 5h on pace (green), 7d under (blue), Fable over
# (amber). The background tint follows the emphasized (Fable) bucket.
ICON_SAMPLE = [(30, COLOR_ON_PACE), (45, COLOR_UNDER_PACE), (70, COLOR_OVER_PACE)]

# --- Screenshots -----------------------------------------------------------
SHOT_SIZE = (1280, 800)
SHOT_BG = (0xF4, 0xF4, 0xF5)
SHOT_BORDER = (0xC8, 0xC8, 0xC8)
# (source in store/src, output name, scale factor, resampling filter).
# Scale factors are integers so pixels stay crisp; NEAREST for the tiny icon
# crop, LANCZOS for the text-heavy tooltip.
SCREENSHOTS = [
    ("tooltip.png", "screenshot-1-tooltip-1280x800.png", 2, Image.Resampling.LANCZOS),
    ("icon.png", "screenshot-2-icon-1280x800.png", 12, Image.Resampling.NEAREST),
]


def with_alpha(rgb, alpha):
    return (*rgb, int(round(alpha * 255)))


def _multiply_alpha(alpha, mask):
    out = Image.new("L", alpha.size)
    a = alpha.load()
    m = mask.load()
    o = out.load()
    w, h = alpha.size
    for y in range(h):
        for x in range(w):
            o[x, y] = a[x, y] * m[x, y] // 255
    return out


def draw_icon(size, buckets, emphasized_index):
    """buckets: list of (utilization_percent, fill_rgb). Returns RGBA size x size."""
    dip = size / ICON_BASE_SIZE
    bar_height = size - round(ICON_BOTTOM_INSET_DIP * dip)
    radius = ICON_CORNER_RADIUS_DIP * dip

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg_color = with_alpha(buckets[emphasized_index][1], ICON_BACKGROUND_ALPHA)
    ImageDraw.Draw(layer).rectangle([0, 0, size - 1, bar_height - 1], fill=bg_color)

    gap = max(1, round(size * ICON_BAR_GAP_FRACTION))
    n = len(buckets)
    base_width = (size - gap * (n - 1)) // n
    leftover = size - (base_width * n + gap * (n - 1))
    widths = [base_width + (leftover if i == emphasized_index else 0) for i in range(n)]

    x = 0
    for i, (util, fill_rgb) in enumerate(buckets):
        w = widths[i]
        track = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(track).rectangle([x, 0, x + w - 1, bar_height - 1], fill=COLOR_TRACK)
        layer = Image.alpha_composite(layer, track)

        fraction = max(ICON_MIN_FILL_FRACTION, min(1.0, util / 100))
        fill_h = max(1, round(bar_height * fraction))
        fill = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(fill).rectangle(
            [x, bar_height - fill_h, x + w - 1, bar_height - 1], fill=(*fill_rgb, 255)
        )
        layer = Image.alpha_composite(layer, fill)
        x += w + gap

    # Clip everything to the rounded rectangle, like ctx.clip() in the JS.
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, bar_height - 1], radius=radius, fill=255)
    layer.putalpha(_multiply_alpha(layer.getchannel("A"), mask))
    return layer


def draw_store_icon():
    """96x96 artwork centered on a transparent 128x128 canvas."""
    canvas = Image.new("RGBA", (STORE_ICON_CANVAS, STORE_ICON_CANVAS), (0, 0, 0, 0))
    artwork = draw_icon(STORE_ICON_ARTWORK, ICON_SAMPLE, EMPHASIZED_INDEX)
    canvas.alpha_composite(artwork, (STORE_ICON_PADDING, STORE_ICON_PADDING))
    return canvas


def make_screenshot(src_name, scale, resample):
    src = Image.open(SRC_DIR / src_name).convert("RGB")
    scaled = src.resize((src.width * scale, src.height * scale), resample)
    if scaled.width > SHOT_SIZE[0] or scaled.height > SHOT_SIZE[1]:
        raise ValueError(f"{src_name} at {scale}x is {scaled.size}, larger than {SHOT_SIZE}")
    canvas = Image.new("RGB", SHOT_SIZE, SHOT_BG)
    x = (SHOT_SIZE[0] - scaled.width) // 2
    y = (SHOT_SIZE[1] - scaled.height) // 2
    canvas.paste(scaled, (x, y))
    ImageDraw.Draw(canvas).rectangle(
        [x - 1, y - 1, x + scaled.width, y + scaled.height], outline=SHOT_BORDER, width=1
    )
    return canvas


def main():
    ICONS_DIR.mkdir(exist_ok=True)
    for size in FULL_BLEED_ICON_SIZES:
        draw_icon(size, ICON_SAMPLE, EMPHASIZED_INDEX).save(ICONS_DIR / f"icon{size}.png")
    draw_store_icon().save(ICONS_DIR / f"icon{STORE_ICON_CANVAS}.png")
    print(f"wrote icons/icon{{{','.join(map(str, FULL_BLEED_ICON_SIZES))},{STORE_ICON_CANVAS}}}.png")
    for src_name, out_name, scale, resample in SCREENSHOTS:
        make_screenshot(src_name, scale, resample).save(STORE_DIR / out_name)
        print(f"wrote store/{out_name}")


if __name__ == "__main__":
    main()
