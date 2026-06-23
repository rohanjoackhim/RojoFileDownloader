from PIL import Image, ImageChops, ImageDraw

img = Image.open('icon.png')
w, h = img.size

# Create 3D metallic radial gradient background (light from top-left)
bg = Image.new('RGBA', (w, h), (90, 92, 100, 255))
draw = ImageDraw.Draw(bg)

# Draw concentric ellipses for 3D sphere/metallic effect
for i in range(200, 0, -3):
    ratio = i / 200
    val = int(90 + ratio * 140)
    r = min(255, val + 10)
    g = min(255, val + 8)
    b = min(255, val + 12)
    draw.ellipse([w//2 - i, h//2 - i, w//2 + i, h//2 + i], fill=(r, g, b, 255))

# Split channels
r, g, b, a = img.split()

# Create mask: pixels are foreground if they have any color (not pure black)
# Background = very dark pixels with alpha > 0 (R<30, G<30, B<30)
# Foreground = transparent corners OR colored circles OR white text
mask_r = r.point(lambda x: 255 if x >= 30 else 0)
mask_g = g.point(lambda x: 255 if x >= 30 else 0)
mask_b = b.point(lambda x: 255 if x >= 30 else 0)
mask_a = a.point(lambda x: 255 if x == 0 else 0)  # keep transparent corners

# OR all masks: if ANY channel >=30 OR alpha==0, it's foreground
mask = ImageChops.lighter(ImageChops.lighter(ImageChops.lighter(mask_r, mask_g), mask_b), mask_a)

# Composite: original image where mask=255 (foreground), silver bg where mask=0 (background)
result = Image.composite(img, bg, mask)
result.save('icon.png')
print('Done - 3D metallic background applied')
