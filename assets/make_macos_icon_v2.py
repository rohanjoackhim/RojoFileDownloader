#!/usr/bin/env python3
"""Create macOS Dock icon: scale logo up 15%, fill background with matching red."""
from PIL import Image
import os
import subprocess

ASSETS = os.path.dirname(os.path.abspath(__file__))
src_path = os.path.join(ASSETS, 'icon.png')

src = Image.open(src_path).convert('RGBA')
w, h = src.size

# Sample the red background color from the center
cx, cy = w // 2, h // 2
red_color = src.getpixel((cx, cy))

# Scale the entire original logo up by 15%
scale = 1.15
new_w = int(w * scale)
new_h = int(h * scale)
scaled = src.resize((new_w, new_h), Image.LANCZOS)

# Create square canvas filled with the red background
icon = Image.new('RGBA', (w, h), red_color)

# Center the scaled logo on the canvas
paste_x = (w - new_w) // 2
paste_y = (h - new_h) // 2
icon.paste(scaled, (paste_x, paste_y), scaled)

# Save intermediate
new_path = os.path.join(ASSETS, 'icon_macos_v2.png')
icon.save(new_path)
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
print("Done! macOS icon updated — logo scaled +15%, background matches red.")
