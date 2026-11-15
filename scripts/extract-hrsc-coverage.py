"""Rasterize the green HRSC footprint outlines in the USGS v2 coverage map.

This is a footprint guide, not a pixel-exact source-provenance raster. The PDF
is a published figure, and its polygon boundaries are rounded for display.
"""

from pathlib import Path
from pypdf import PdfReader
from pypdf.generic import ContentStream
from PIL import Image, ImageDraw
import hashlib
import json
import math
import sys

SOURCE = Path(sys.argv[1] if len(sys.argv) > 1 else "work/hrsc_coveragemap_v2.pdf")
OUT = Path("data")
WIDTH, HEIGHT = 5280, 2616
# Exact rectangular map frame in the published PDF's page coordinates. The
# white page margins are not Mars and must never become longitude/latitude.
MAP_LEFT, MAP_RIGHT = 96.241, 1223.766
MAP_SOUTH, MAP_NORTH = 45.182, 608.893

def map_point(x, y):
    return ((x - MAP_LEFT) / (MAP_RIGHT - MAP_LEFT) * WIDTH,
            (MAP_NORTH - y) / (MAP_NORTH - MAP_SOUTH) * HEIGHT)

reader = PdfReader(SOURCE)
page = reader.pages[0]
operations = ContentStream(page.get_contents(), reader).operations
image = Image.new("1", (WIDTH, HEIGHT), 0)
draw = ImageDraw.Draw(image)
green = False
points = []
count = 0
large = []

def paint():
    global count, points
    if len(points) >= 3:
        xs, ys = zip(*points)
        box_area = (max(xs) - min(xs)) * (max(ys) - min(ys)) / (WIDTH * HEIGHT)
        # Map-edge clipping joins some unrelated outline segments into huge
        # self-intersecting paths. Individual HRSC swaths occupy far less than
        # five percent of the rectangular world map.
        if box_area < .05:
            draw.polygon(points, fill=1)
            count += 1
        else:
            large.append((round(box_area, 3), len(points), tuple(round(v, 1) for v in (min(xs), min(ys), max(xs), max(ys)))))
    points = []

for args, op in operations:
    if op == b"RG":
        paint()
        green = tuple(float(v) for v in args) == (0.0, 1.0, 0.0)
    elif not green:
        continue
    elif op == b"m":
        paint()
        points = [map_point(float(args[0]), float(args[1]))]
    elif op == b"l" and points:
        points.append(map_point(float(args[0]), float(args[1])))
    elif op in (b"S", b"s", b"n"):
        paint()
paint()

pixels = image.tobytes()
OUT.mkdir(exist_ok=True)
(OUT / "hrsc-coverage.bin").write_bytes(pixels)
weighted_covered = weighted_total = 0.0
for y in range(HEIGHT):
    weight = math.cos(math.pi * (0.5 - (y + .5) / HEIGHT))
    row = pixels[y * ((WIDTH + 7) // 8):(y + 1) * ((WIDTH + 7) // 8)]
    weighted_covered += sum(byte.bit_count() for byte in row) * weight
    weighted_total += WIDTH * weight
metadata = {
    "schemaVersion": 1,
    "width": WIDTH,
    "height": HEIGHT,
    "bitOrder": "most-significant-first",
    "longitudeDomain": "-180..180 east-positive",
    "pdfMapFrame": [MAP_LEFT, MAP_SOUTH, MAP_RIGHT, MAP_NORTH],
    "source": "USGS HRSC Coverage Map v2",
    "sourceUrl": "https://astrogeology.usgs.gov/ckan/dataset/6c177b5f-97af-4d70-adc3-92cf362b9890/resource/db5a4915-4820-45b2-9d94-2a37e322b291/download/hrsc_coveragemap_v2.pdf",
    "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "maskSha256": hashlib.sha256(pixels).hexdigest(),
    "approxAreaFraction": round(weighted_covered / weighted_total, 4),
    "note": "PDF map frame calibrated to 0–360° longitude and ±90° latitude. Approximate footprint guide only; 5 km blended edges and unknown per-pixel source provenance."
}
(OUT / "hrsc-coverage.json").write_text(json.dumps(metadata, indent=2) + "\n")
print(json.dumps({"polygons": count, "excluded": large[:20], "bytes": len(pixels), "areaFraction": metadata["approxAreaFraction"]}))
