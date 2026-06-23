#!/usr/bin/env python3
"""Convert icon.png to .icns (macOS) and .ico (Windows) for Electron app."""
from PIL import Image
import os
import subprocess

ASSETS = os.path.dirname(os.path.abspath(__file__))
png_path = os.path.join(ASSETS, 'icon.png')

# --- Convert PNG to ICO ---
img = Image.open(png_path)
# ICO needs multiple sizes
ico_path = os.path.join(ASSETS, 'icon.ico')
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(ico_path, format='ICO', sizes=sizes)
print(f"Created {ico_path}")

# --- Convert PNG to ICNS (macOS) ---
# Use sips + iconutil on macOS
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
    subprocess.run(['sips', '-z', str(size), str(size), png_path, '--out', out], check=True)

icns_path = os.path.join(ASSETS, 'icon.icns')
subprocess.run(['iconutil', '-c', 'icns', iconset_dir, '-o', icns_path], check=True)

# Cleanup
import shutil
shutil.rmtree(iconset_dir)
print(f"Created {icns_path}")
print("Done! All app icons updated.")
