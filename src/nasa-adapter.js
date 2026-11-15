import { terrainSlopeDegrees, traversable } from './terrain.js';

export function decodeTerrain(metadata, buffer) {
  const { width, height, bounds, radiusKm } = metadata;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width * height > 2e6) throw new Error('Invalid terrain dimensions');
  const bytesPerSample = metadata.encoding === 'int16-be' ? 2 : metadata.encoding === 'float32-le' ? 4 : 0;
  if (!bytesPerSample || buffer.byteLength !== width * height * bytesPerSample) throw new Error('Invalid elevation file');
  if (!bounds || !Object.values(bounds).every(Number.isFinite) || bounds.north <= bounds.south || bounds.east <= bounds.west || bounds.north > 90 || bounds.south < -90 || bounds.west < 0 || bounds.east > 360 || !Number.isFinite(radiusKm) || radiusKm <= 0) throw new Error('Invalid map coordinates');
  const view = new DataView(buffer);
  const elevation = new Float32Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < elevation.length; i++) {
    const value = bytesPerSample === 2 ? view.getInt16(i * 2, false) : view.getFloat32(i * 4, true);
    elevation[i] = value === metadata.noData || !Number.isFinite(value) ? NaN : value;
    if (Number.isFinite(elevation[i])) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  if (!Number.isFinite(min)) throw new Error('Terrain has no valid elevations');
  const cellKm = radiusKm * Math.PI / 180 * (bounds.north - bounds.south) / height;
  return { ...metadata, elevation, min, max, cellKm, risk: new Float32Array(width * height) };
}

export function deriveSlopes(terrain) {
  const slopes = new Float32Array(terrain.width * terrain.height);
  // Maximum neighbor gradient at each sample, in degrees; not a hazard map.
  for (let y = 0; y < terrain.height; y++) for (let x = 0; x < terrain.width; x++) {
    const node = y * terrain.width + x;
    if (!traversable(terrain, node)) { slopes[node] = NaN; continue; }
    let max = 0;
    for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nx = x + dx, ny = y + dy, other = ny * terrain.width + nx;
      if (nx >= 0 && nx < terrain.width && ny >= 0 && ny < terrain.height && traversable(terrain, other)) max = Math.max(max, terrainSlopeDegrees(terrain, node, other));
    }
    slopes[node] = max;
    terrain.risk[node] = Math.min(1, max / 30);
  }
  terrain.slopes = slopes;
  return terrain;
}

export async function loadNasaTerrain(id, signal) {
  if (id !== 'mars-global') throw new Error('Unknown dataset');
  const metaResponse = await fetch(`data/${id}.json`, { signal });
  if (!metaResponse.ok) throw new Error('Could not load terrain metadata');
  const metadata = await metaResponse.json();
  const response = await fetch(`data/${id}.bin`, { signal });
  if (!response.ok) throw new Error('Could not load elevation data');
  const buffer = await response.arrayBuffer();
  if (globalThis.crypto?.subtle && metadata.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== metadata.sha256) throw new Error('Terrain checksum mismatch');
  }
  return deriveSlopes(decodeTerrain(metadata, buffer));
}
