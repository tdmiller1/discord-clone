#!/usr/bin/env python3
"""Generate the app source icon (app-icon.png, 1024x1024).

The previous source was a flat blurple square with no artwork, so every
platform icon Tauri generated from it was a featureless blue box (Windows)
or got dropped to the desktop default (GNOME). This draws an actual logo:
a white chat bubble with a typing-dots motif on the brand blurple, which
stays legible all the way down to 16x16.

Re-run after editing, then regenerate the platform icons:
    python3 make-icon.py && npx tauri icon app-icon.png
"""
from PIL import Image, ImageDraw

BLURPLE = (88, 101, 242, 255)   # #5865F2 — existing brand color
WHITE = (255, 255, 255, 255)

S = 4                            # supersample factor for clean anti-aliasing
N = 1024
px = N * S

img = Image.new("RGBA", (px, px), BLURPLE)
d = ImageDraw.Draw(img)

# Chat bubble body: rounded rect, centered, with padding so it survives the
# rounded-corner / squircle masking the OS applies.
bx0, by0, bx1, by1 = int(0.20 * px), int(0.24 * px), int(0.80 * px), int(0.64 * px)
radius = int(0.11 * px)
d.rounded_rectangle([bx0, by0, bx1, by1], radius=radius, fill=WHITE)

# Tail at the bottom-left, pointing down — classic speech-bubble look.
tail_x = bx0 + int(0.14 * px)
tail = [
    (tail_x, by1 - int(0.02 * px)),
    (tail_x + int(0.13 * px), by1 - int(0.02 * px)),
    (tail_x, by1 + int(0.14 * px)),
]
d.polygon(tail, fill=WHITE)

# Three blurple dots (typing indicator) inside the bubble.
cy = (by0 + by1) // 2
r = int(0.035 * px)
gap = int(0.135 * px)
cx = (bx0 + bx1) // 2
for dx in (-gap, 0, gap):
    d.ellipse([cx + dx - r, cy - r, cx + dx + r, cy + r], fill=BLURPLE)

img = img.resize((N, N), Image.LANCZOS)
img.save("app-icon.png")
print("wrote app-icon.png", img.size)
