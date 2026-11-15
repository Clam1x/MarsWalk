"""Build a planet-scale preview from the official USGS DTM footprint polygons.

The PNG is a zoomed-out availability guide. At close zoom the browser queries
the exact catalogue polygon instead of enlarging this raster.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import hashlib
import json
import sys

source = sys.argv[1] if len(sys.argv) > 1 else None
if source not in ("ctx", "hirise"):
    raise SystemExit("Pass ctx or hirise")

WIDTH, HEIGHT = 5280, 2616
INPUT = Path(f"work/area-{source}.jsonl")
OUTPUT = Path(f"data/area-{source}.png")
COLLECTIONS = {"ctx": "mro_ctx_controlled_usgs_dtms", "hirise": "mro_hirise_socet_dtms"}
mask = Image.new("L", (WIDTH, HEIGHT), 0)
count = 0

def polygons(geometry):
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"]]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"]
    return []

def paint(polygon):
    exterior = polygon[0]
    if len(exterior) < 3:
        return
    lons = [(point[0] + 360) % 360 for point in exterior]
    crosses = max(lons) - min(lons) > 180
    for shift in ((0, -360) if crosses else (0,)):
        def project(ring):
            return [(((lon + 360) % 360 + (360 if crosses and (lon + 360) % 360 < 180 else 0) + shift) / 360 * WIDTH,
                     (90 - lat) / 180 * HEIGHT) for lon, lat, *_ in ring]
        rings = [project(ring) for ring in polygon if len(ring) >= 3]
        if not rings:
            continue
        xs = [x for ring in rings for x, y in ring]
        ys = [y for ring in rings for x, y in ring]
        left = max(0, int(min(xs)) - 1)
        top = max(0, int(min(ys)) - 1)
        right = min(WIDTH, int(max(xs)) + 2)
        bottom = min(HEIGHT, int(max(ys)) + 2)
        if right <= left or bottom <= top:
            continue
        local = Image.new("L", (right - left, bottom - top), 0)
        draw = ImageDraw.Draw(local)
        draw.polygon([(x - left, y - top) for x, y in rings[0]], fill=255)
        for ring in rings[1:]:
            draw.polygon([(x - left, y - top) for x, y in ring], fill=0)
        mask.paste(255, (left, top), local)

with INPUT.open(encoding="utf-8") as stream:
    for line in stream:
        item = json.loads(line)
        for polygon in polygons(item["geometry"]):
            paint(polygon)
        count += 1

color = (233, 176, 240) if source == "ctx" else (117, 217, 237)
image = Image.new("RGB", (WIDTH, HEIGHT), color)
image.putalpha(mask.point(lambda value: 80 if value else 0))
OUTPUT.parent.mkdir(exist_ok=True)
image.save(OUTPUT, optimize=True)
meta_path = OUTPUT.parent / "area-overview.json"
meta = json.loads(meta_path.read_text()) if meta_path.exists() else {"schemaVersion": 1, "width": WIDTH, "height": HEIGHT, "sources": {}}
meta["sources"][source] = {
    "collection": COLLECTIONS[source], "products": count,
    "catalogue": "https://stac.astrogeology.usgs.gov/api/search",
    "pngSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
    "note": "Filled planet-scale DTM footprint guide; exact catalogue polygons load in close views. Footprints can contain invalid height cells, so route source colors may cover only part of a footprint."
}
meta_path.write_text(json.dumps(meta, indent=2) + "\n")
print(f"{source}: {count} polygons, {OUTPUT.stat().st_size} PNG bytes")
