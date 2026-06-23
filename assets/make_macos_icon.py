#!/usr/bin/env python3
"""Create a proper macOS Dock icon that fills the square for natural squircle masking."""
from PIL import Image
import os
import subprocess

ASSETS = os.path.dirname(os.path.abspath(__file__))
src_path = os.path.join(ASSETS, 'icon.png')

src = Image.open(src_path).convert('RGBA')
w, h = src.size

# Find the dominant red background color by sampling center pixels
cx, cy = w // 2, h // 2
red_color = src.getpixel((cx, cy))

# Create new square icon with the red filling the ENTIRE square
new_icon = Image.new('RGBA', (w, h), red_color)

# Overlay non-red pixels (the white play triangle and shadows/highlights)
src_data = src.load()
new_data = new_icon.load()

for y in range(h):
    for x in range(w):
        r, g, b, a = src_data[x, y]
        if a < 30:
            continue  # Skip transparent pixels
        # If this pixel is NOT the red background color, overlay it
        # Use a tolerance since anti-aliased edges vary
        red_r, red_g, red_b, _ = red_color
        dist = abs(r - red_r) + abs(g - red_g) + abs(b - red_b)
        if dist > 60:
            new_data[x, y] = (r, g, b, a)

# Save intermediate
new_path = os.path.join(ASSETS, 'icon_macos.png')
new_icon.save(new_path)
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
print("Done! macOS icon updated for proper Dock appearance.")
