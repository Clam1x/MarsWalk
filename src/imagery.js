export const imageryLayers = {
  geology: {
    label: 'USGS global geology (SIM 3292)',
    id: 'Mars_geology_All_layers_100pct', provider: 'usgs-geology', tilePixels: 256, maxZoom: 6,
    coverage: {west: 0, east: 360, south: -90, north: 90},
    nativeResolution: 'regional 1:20,000,000 geologic mapping; not a terrain or mineral measurement'
  },
  viking: {
    label: 'Viking VIS',
    id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m',
    provider: 'mars-trek', tilePixels: 256, maxZoom: 7, coverage: {west: 0, east: 360, south: -90, north: 90},
    nativeResolution: '232 m/px at the equator'
  },
  ctx: {
    label: 'CTX global mosaic',
    // The service advertises higher LODs, but its tile endpoint returns HTTP 400
    // at level 13 and above across sampled planet locations.
    id: 'CTX1', provider: 'arcgis', tilePixels: 512, maxZoom: 12,
    coverage: {west: 0, east: 360, south: -88, north: 88},
    nativeResolution: '5 m/px global mosaic; about 99.5% coverage within ±88° latitude'
  },
  hirise: {
    label: 'HiRISE image mosaic',
    id: 'HiRISE', provider: 'arcgis', tilePixels: 512, maxZoom: 17,
    coverage: {west: 0, east: 360, south: -90, north: 90},
    nativeResolution: '0.25–1 m/px images; sparse coverage (~3%, through 2018); location may be off by hundreds of metres'
  }
};

export function tileZoom(frameWidth, longitudeSpan, maxZoom, tilePixels=256,worldDegrees=180) {
  const pxPerDegree = frameWidth / longitudeSpan;
  return Math.max(0, Math.min(maxZoom, Math.round(Math.log2(worldDegrees * pxPerDegree / tilePixels))));
}

export function tileUrl(layer, zoom, row, col) {
  const spec = imageryLayers[layer];
  if (!spec || !Number.isInteger(zoom) || zoom < 0 || zoom > spec.maxZoom) throw new Error('Invalid imagery tile');
  return spec.provider==='usgs-geology'
    ? `https://tiles.arcgis.com/tiles/nzS0F0zdNLvs7nc8/arcgis/rest/services/${spec.id}/MapServer/tile/${zoom}/${row}/${col}`
    : spec.provider==='mars-trek'
    ? `https://trek.nasa.gov/tiles/Mars/EQ/${spec.id}/1.0.0/default/default028mm/${zoom}/${row}/${col}.jpg`
    : `https://astro.arcgis.com/arcgis/rest/services/OnMars/${spec.id}/MapServer/tile/${zoom}/${row}/${col}`;
}

export function tileKey(layer, zoom, row, col) { return `${layer}/${zoom}/${row}/${col}`; }

// Mars Trek WMTS uses -180..180 longitude, while MarsWalk uses 0..360.
export function visibleTiles(layer, bounds, frame, viewport, zoom) {
  const spec = imageryLayers[layer];
  if (!spec) return [];
  const lonSpan = bounds.east - bounds.west, latSpan = bounds.north - bounds.south;
  const west = Math.max(bounds.west, spec.coverage.west, bounds.west + (0 - frame.x) / frame.w * lonSpan);
  const east = Math.min(bounds.east, spec.coverage.east, bounds.west + (viewport.width - frame.x) / frame.w * lonSpan);
  const north = Math.min(bounds.north, spec.coverage.north, bounds.north - (0 - frame.y) / frame.h * latSpan);
  const south = Math.max(bounds.south, spec.coverage.south, bounds.north - (viewport.height - frame.y) / frame.h * latSpan);
  if (west >= east || south >= north) return [];
  const geology=spec.provider==='usgs-geology',tileDegrees = (geology?360:180) / 2 ** zoom;
  const rowOrigin=geology?180:90,rows=2**zoom,columns=2**(zoom+(geology?0:1));
  const firstRow = Math.max(0, Math.floor((rowOrigin - north) / tileDegrees));
  const lastRow = Math.min(rows - 1, Math.ceil((rowOrigin - south) / tileDegrees) - 1);
  const out = [];
  for (const [start, end, offset] of [[0, 180, 0], [180, 360, -360]]) {
    const a = Math.max(west, start), b = Math.min(east, end);
    if (a >= b) continue;
    const firstCol = Math.max(0, Math.floor((a + offset + 180) / tileDegrees));
    const lastCol = Math.min(columns - 1, Math.ceil((b + offset + 180) / tileDegrees) - 1);
    for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) {
      const tileWest = -180 + col * tileDegrees - offset;
      const tileNorth = rowOrigin - row * tileDegrees;
      out.push({ zoom, row, col, key: tileKey(layer, zoom, row, col),
        x: frame.x + (tileWest - bounds.west) / lonSpan * frame.w,
        y: frame.y + (bounds.north - tileNorth) / latSpan * frame.h,
        w: tileDegrees / lonSpan * frame.w,
        h: tileDegrees / latSpan * frame.h });
    }
  }
  return out;
}

export class ImageryTiles {
  constructor(redraw) { this.redraw = redraw; this.cache = new Map(); this.local = {}; }
  setLocal(files) { this.local = files || {}; }
  get(layer, tile) {
    if (this.cache.has(tile.key)) { const cached=this.cache.get(tile.key);this.cache.delete(tile.key);this.cache.set(tile.key,cached);return cached; }
    const entry = { state: 'loading', image: new Image() };
    this.cache.set(tile.key, entry);
    if(this.cache.size>256){const oldest=this.cache.keys().next().value;this.cache.delete(oldest);}
    const remote = tileUrl(layer, tile.zoom, tile.row, tile.col);
    entry.image.onload = () => { entry.state = 'ready'; this.redraw(); };
    entry.image.onerror = () => {
      if (entry.local) { entry.local = false; entry.image.src = remote; }
      else { entry.state = 'error'; this.redraw(); }
    };
    entry.local = Boolean(this.local[tile.key]);
    entry.image.src = entry.local ? `data/imagery/${this.local[tile.key]}` : remote;
    return entry;
  }
}
