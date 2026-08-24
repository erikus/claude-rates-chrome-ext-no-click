# Generates the static Web Store assets:
#   icons/icon{16,48,128}.png       - manifest icons (also the store icon)
#   store/screenshot-1280x800.png   - store listing screenshot
#
# Run from the repo root:  uv run --with pillow store/gen_assets.py
#
# The icon drawing is a port of drawIcon() in background.js. Keep the geometry
# constants in sync with that file if they change there.

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
ICONS_DIR = REPO / "icons"
STORE_DIR = REPO / "store"

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

# --- Sample data -----------------------------------------------------------
# Manifest/store icon: everything on pace.
ICON_SAMPLE = [(30, COLOR_ON_PACE), (45, COLOR_ON_PACE), (60, COLOR_ON_PACE)]
# Screenshot: one bucket per color so the pace idea is visible.
SHOT_SAMPLE = [(12, COLOR_ON_PACE), (22, COLOR_UNDER_PACE), (58, COLOR_OVER_PACE)]
SHOT_TOOLTIP = [
    "Rate Limits for Claude",
    "5h: 12% (resets in 3h 13m)",
    "7d: 22% (17 pts under pace, 39% expected; resets in 4d 6h)",
    "Fable: 58% (19 pts over pace, 39% expected; resets in 4d 6h)",
    "Updated 12m ago",
    "Blue = under pace, green = on pace, amber/red = over pace",
    "Click to refresh",
]

# --- Screenshot layout -----------------------------------------------------
SHOT_SIZE = (1280, 800)
SHOT_BG = (0xF4, 0xF4, 0xF5)
TOOLBAR_BG = (0xFF, 0xFF, 0xFF)
TOOLBAR_BORDER = (0xDA, 0xDA, 0xDA)
TOOLTIP_BG = (0xF0, 0xF0, 0xF0)
TOOLTIP_BORDER = (0xB0, 0xB0, 0xB0)
TEXT_DARK = (0x20, 0x20, 0x20)
TEXT_MUTED = (0x60, 0x60, 0x60)
ICON_RENDER_SIZE = 192
FONT_PATH = "/System/Library/Fonts/Helvetica.ttc"


def with_alpha(rgb, alpha):
    return (*rgb, int(round(alpha * 255)))


def draw_icon(size, buckets, emphasized_index):
    """buckets: list of (utilization_percent, fill_rgb)."""
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


def font(size):
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def make_screenshot():
    img = Image.new("RGB", SHOT_SIZE, SHOT_BG)
    d = ImageDraw.Draw(img)

    title_font = font(44)
    sub_font = font(22)
    tip_font = font(24)

    d.text((80, 70), "Rate Limits for Claude", font=title_font, fill=TEXT_DARK)
    d.text(
        (80, 130),
        "Your 5-hour, 7-day, and Fable usage as toolbar bars, colored by pace. No click needed.",
        font=sub_font,
        fill=TEXT_MUTED,
    )

    # Fake toolbar strip with the icon in it.
    strip_top, strip_h = 230, 300
    d.rectangle([80, strip_top, 1200, strip_top + strip_h], fill=TOOLBAR_BG, outline=TOOLBAR_BORDER, width=2)
    icon = draw_icon(ICON_RENDER_SIZE, SHOT_SAMPLE, EMPHASIZED_INDEX)
    icon_x = 140
    icon_y = strip_top + (strip_h - ICON_RENDER_SIZE) // 2
    img.paste(icon, (icon_x, icon_y), icon)

    # Tooltip box to the right of the icon.
    pad = 24
    line_gap = 10
    line_h = tip_font.getbbox("Ag")[3] + line_gap
    box_w = max(d.textlength(line, font=tip_font) for line in SHOT_TOOLTIP) + 2 * pad
    box_h = line_h * len(SHOT_TOOLTIP) + 2 * pad - line_gap
    box_x = icon_x + ICON_RENDER_SIZE + 60
    box_y = strip_top + (strip_h - box_h) // 2
    d.rounded_rectangle(
        [box_x, box_y, box_x + box_w, box_y + box_h], radius=8, fill=TOOLTIP_BG, outline=TOOLTIP_BORDER, width=2
    )
    y = box_y + pad
    for line in SHOT_TOOLTIP:
        d.text((box_x + pad, y), line, font=tip_font, fill=TEXT_DARK)
        y += line_h

    # Legend.
    legend_y = strip_top + strip_h + 60
    legend = [
        (COLOR_UNDER_PACE, "Blue: under pace - weekly quota will go unused at reset"),
        (COLOR_ON_PACE, "Green: on pace"),
        (COLOR_OVER_PACE, "Amber: over pace - you will run out before the reset"),
    ]
    for rgb, text in legend:
        d.rounded_rectangle([80, legend_y, 80 + 28, legend_y + 28], radius=5, fill=rgb)
        d.text((124, legend_y - 2), text, font=sub_font, fill=TEXT_DARK)
        legend_y += 48

    d.text(
        (80, SHOT_SIZE[1] - 70),
        "Unofficial. Not affiliated with Anthropic. Reads usage from your existing claude.ai login; nothing leaves your browser.",
        font=font(18),
        fill=TEXT_MUTED,
    )
    return img


def main():
    ICONS_DIR.mkdir(exist_ok=True)
    for size in (16, 48, 128):
        draw_icon(size, ICON_SAMPLE, EMPHASIZED_INDEX).save(ICONS_DIR / f"icon{size}.png")
    make_screenshot().save(STORE_DIR / "screenshot-1280x800.png")
    print("wrote icons/icon{16,48,128}.png and store/screenshot-1280x800.png")


if __name__ == "__main__":
    main()
