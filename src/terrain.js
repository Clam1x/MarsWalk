export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function terrainSlopeDegrees(terrain, from, to) {
  const riseKm = Math.abs(elevationAtNode(terrain, to) - elevationAtNode(terrain, from)) / 1000;
  const runKm = terrainDistanceKm(terrain, from, to);
  return runKm ? Math.atan2(riseKm, runKm) * 180 / Math.PI : 0;
}

export function elevationAtNode(terrain, node) {
  return terrain.heightAt ? terrain.heightAt(node) : terrain.elevation[node];
}

export function terrainDistanceKm(terrain, from, to) {
  const fx = from % terrain.width;
  const fy = Math.floor(from / terrain.width);
  const tx = to % terrain.width;
  const ty = Math.floor(to / terrain.width);
  if (!terrain.bounds) return Math.hypot(tx - fx, ty - fy) * terrain.cellKm;
  const xSteps = terrain.wrapLongitude ? Math.min(Math.abs(tx - fx), terrain.width - Math.abs(tx - fx)) : Math.abs(tx - fx);
  const ySteps = Math.abs(ty - fy);
  if (xSteps <= 1 && ySteps <= 1) {
    const bounds = terrain.bounds, radians = Math.PI / 180;
    const latitude = bounds.north - ((fy + ty) / 2 + 0.5) * (bounds.north - bounds.south) / terrain.height;
    const northSouthKm = (bounds.north - bounds.south) / terrain.height * radians * terrain.radiusKm * ySteps;
    const eastWestKm = (bounds.east - bounds.west) / terrain.width * radians * terrain.radiusKm * Math.cos(latitude * radians) * xSteps;
    return Math.hypot(eastWestKm, northSouthKm);
  }
  const a = gridToMarsCoordinate(fx, fy, terrain);
  const b = gridToMarsCoordinate(tx, ty, terrain);
  const radians = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * radians / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((b.lon - a.lon) * radians / 2) ** 2;
  return 2 * terrain.radiusKm * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

export function gridToMarsCoordinate(x, y, terrain) {
  if (!terrain.bounds) throw new Error('Geographic bounds are required');
  if(terrain.nativeGeo){
    const g=terrain.nativeGeo,sourceX=Math.floor((x+.5)*g.width/terrain.width),sourceY=Math.floor((y+.5)*g.height/terrain.height);
    const column=(sourceX+g.width/2)%g.width;
    return {lat:g.north-(sourceY+.5)*g.pixelDegrees,lon:(g.west+(column+.5)*g.pixelDegrees+360)%360};
  }
  const bounds = terrain.bounds;
  return {
    lat: bounds.north - (y + 0.5) * (bounds.north - bounds.south) / terrain.height,
    lon: bounds.west + (x + 0.5) * (bounds.east - bounds.west) / terrain.width
  };
}

export function coordinateToGrid(lat, lon, terrain) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const bounds = terrain.bounds;
  if (!bounds || lat > bounds.north || lat < bounds.south || lon < bounds.west || lon > bounds.east) return null;
  return {
    x: clamp(Math.floor((lon - bounds.west) / (bounds.east - bounds.west) * terrain.width), 0, terrain.width - 1),
    y: clamp(Math.floor((bounds.north - lat) / (bounds.north - bounds.south) * terrain.height), 0, terrain.height - 1)
  };
}

export function traversable(terrain, node) {
  const elevation = elevationAtNode(terrain, node);
  return Number.isInteger(node) && node >= 0 && node < terrain.width * terrain.height && Number.isFinite(elevation) && elevation !== terrain.noData && !terrain.blocked?.[node];
}
