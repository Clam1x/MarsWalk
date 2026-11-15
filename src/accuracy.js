// These are properties of the elevation grid, not a probability that a route is safe.
export function cellMetrics(terrain, node) {
  if (!terrain.bounds) {
    const side = terrain.cellKm * 1000;
    return { eastWestM: side, northSouthM: side, centreOffsetM: Math.SQRT2 * side / 2 };
  }
  const row = Math.floor(node / terrain.width);
  const latitude = terrain.bounds.north - (row + 0.5) * (terrain.bounds.north - terrain.bounds.south) / terrain.height;
  const radians = Math.PI / 180;
  const northSouthM = terrain.radiusKm * 1000 * radians * (terrain.bounds.north - terrain.bounds.south) / terrain.height;
  const eastWestM = terrain.radiusKm * 1000 * radians * (terrain.bounds.east - terrain.bounds.west) / terrain.width * Math.cos(latitude * radians);
  return { eastWestM, northSouthM, centreOffsetM: Math.hypot(eastWestM, northSouthM) / 2 };
}

export function routeInputQuality(terrain, path) {
  if (!path.length) return null;
  let maxSpacingM = 0;
  let maxCentreOffsetM = 0;
  for (const node of path) {
    const cell = cellMetrics(terrain, node);
    maxSpacingM = Math.max(maxSpacingM, cell.eastWestM, cell.northSouthM);
    maxCentreOffsetM = Math.max(maxCentreOffsetM, cell.centreOffsetM);
  }
  return {
    source: terrain.id === 'mars-routing' ? 'Global MOLA 16 px/°' : 'MOLA MEGDR',
    maxSpacingM,
    maxCentreOffsetM,
    samples: path.length,
    coveragePercent: 100,
    verticalDatum: terrain.source?.verticalDatum ?? null
  };
}

export function terrainMeetsDetail(terrain, limitM) {
  if (limitM === Infinity) return true;
  if (!Number.isFinite(limitM) || limitM <= 0) return false;
  const a = cellMetrics(terrain, 0);
  const b = cellMetrics(terrain, terrain.width * (terrain.height - 1));
  return Math.max(a.eastWestM, a.northSouthM, b.eastWestM, b.northSouthM) <= limitM + 0.01;
}
