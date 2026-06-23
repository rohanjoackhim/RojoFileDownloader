#!/usr/bin/env python3
"""Create macOS Dock icon with gradient background matching the logo."""
from PIL import Image
import os
import subprocess

ASSETS = os.path.dirname(os.path.abspath(__file__))
src_path = os.path.join(ASSETS, 'icon.png')

src = Image.open(src_path).convert('RGBA')
w, h = src.size

# Find the bounds of the visible logo (non-transparent pixels)
alpha = src.split()[3]
bbox = alpha.getbbox()
if not bbox:
    raise ValueError("Could not find logo bounds")

left, top, right, bottom = bbox
logo_w = right - left
logo_h = bottom - top
center_x = left + logo_w // 2
center_y = top + logo_h // 2

# Sample gradient colors from the logo's top and bottom (avoiding edges for clean color)
sample_margin = max(1, logo_h // 10)
top_color = src.getpixel((center_x, top + sample_margin))
bottom_color = src.getpixel((center_x, bottom - sample_margin))

# Extract RGB (ignore alpha for gradient)
top_r, top_g, top_b, _ = top_color
bot_r, bot_g, bot_b, _ = bottom_color

def create_gradient(width, height, top_rgb, bottom_rgb):
    """Create a vertical gradient from top_rgb to bottom_rgb."""
    img = Image.new('RGBA', (width, height))
    pixels = img.load()
    tr, tg, tb = top_rgb
    br, bg, bb = bottom_rgb
    for y in range(height):
        t = y / (height - 1) if height > 1 else 0
        r = int(tr + (br - tr) * t)
        g = int(tg + (bg - tg) * t)
        b = int(tb + (bb - tb) * t)
        for x in range(width):
            pixels[x, y] = (r, g, b, 255)
    return img

# Create gradient background
gradient_bg = create_gradient(w, h, (top_r, top_g, top_b), (bot_r, bot_g, bot_b))

# Scale the original logo up by 15%
scale = 1.15
new_w = int(w * scale)
new_h = int(h * scale)
scaled = src.resize((new_w, new_h), Image.LANCZOS)

# Center the scaled logo on the gradient background
paste_x = (w - new_w) // 2
paste_y = (h - new_h) // 2
gradient_bg.paste(scaled, (paste_x, paste_y), scaled)

# Save intermediate
new_path = os.path.join(ASSETS, 'icon_macos_v3.png')
gradient_bg.save(new_path)
print(f"Created {new_path}")

# --- Convert PNG to ICNS (macOS) ---
iconset_dir = os.path.join(ASSETS, 'icon.iconset')
os.makedirs(iconset_dir, exist_ok=True)

sizes_icns = [
    (16, '16x16'), (32, '16x16@2x'),
    (32, '32x32'), (64, '32x32@2x'),
    (128, '128x128'), (256, '128x128@2x'),
    (256, '256x256'), (512, '256x256@2x'),
    (512, '512x512'), (1024, '512x512@2x'),
]

for size, name in sizes_icns:
    out = os.path.join(iconset_dir, f'icon_{name}.png')
    subprocess.run(['sips', '-z', str(size), str(size), new_path, '--out', out], check=True)

icns_path = os.path.join(ASSETS, 'icon.icns')
subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', icns_path], check=True)

# Cleanup
import shutil
shutil.rmtree(iconset_dir)
os.remove(new_path)
print(f"Created {icns_path}")
print("Done! macOS icon updated — gradient background +15% logo.")
