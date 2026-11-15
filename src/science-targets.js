import { coordinateToGrid } from './terrain.js';
import { destinationAt } from './mars-geometry.js';
import { nearbyMappedFeatures } from './geologic-features.js';

export const GEOLOGY_SOURCE = 'https://services.arcgis.com/nzS0F0zdNLvs7nc8/ArcGIS/rest/services/Mars_Geology_feature_layer/FeatureServer/0';
export { destinationAt } from './mars-geometry.js';

export async function geologyAt(point, fetcher = fetch, signal) {
  const lon = point.lon > 180 ? point.lon - 360 : point.lon;
  const url = new URL(`${GEOLOGY_SOURCE}/query`);
  url.search = new URLSearchParams({geometry:`${lon.toFixed(6)},${point.lat.toFixed(6)}`,
    geometryType:'esriGeometryPoint',spatialRel:'esriSpatialRelIntersects',outFields:'Unit,UnitDesc',
    returnGeometry:'false',f:'json'}).toString();
  const timeout=AbortSignal.timeout(6000);
  const response = await fetcher(url.toString(), {signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if (!response.ok) throw new Error('Global geology service unavailable');
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Global geology query failed');
  const attributes = data.features?.[0]?.attributes;
  return attributes?.Unit ? {unit:String(attributes.Unit),description:String(attributes.UnitDesc || attributes.Unit)} : null;
}

function elevationAt(point, terrain) {
  const cell = coordinateToGrid(point.lat, point.lon, terrain);
  if (!cell) return null;
  const elevation = terrain.elevation[cell.y * terrain.width + cell.x];
  return Number.isFinite(elevation) ? elevation : null;
}

export async function suggestGlobalScienceTargets(origin, terrain, {fetcher=fetch, signal}={}) {
  if (elevationAt(origin,terrain) === null) throw new Error('No elevation at the expedition base');
  const samples = [1.2, 2.5, 4].flatMap(distanceKm =>
    [0,45,90,135,180,225,270,315].map(bearing => ({point:destinationAt(origin,bearing,distanceKm),distanceKm,bearing})));
  const valid = samples.map(sample => ({...sample,elevationM:elevationAt(sample.point,terrain)}))
    .filter(sample => sample.elevationM !== null);
  let baseGeology = null, availableGeology = false;
  try { baseGeology = await geologyAt(origin,fetcher,signal); availableGeology = baseGeology !== null; }
  catch (error) { if (signal?.aborted) throw error; }
  const candidates = [];
  // Keep the public service responsive: a small bounded sample, at most four concurrent requests.
  for (let i=0;i<valid.length;i+=4) {
    if (signal?.aborted) throw new DOMException('Aborted','AbortError');
    const batch = valid.slice(i,i+4);
    const results = await Promise.all(batch.map(async sample => {
      let geology = null;
      if (availableGeology) {
        try { geology = await geologyAt(sample.point,fetcher,signal); }
        catch (error) { if (signal?.aborted) throw error; availableGeology=false; }
      }
      return {...sample,geology};
    }));
    candidates.push(...results);
  }
  const mappedUnits=candidates.filter(candidate=>baseGeology&&candidate.geology&&candidate.geology.unit!==baseGeology.unit).map(candidate=>{
    const different = baseGeology && candidate.geology && candidate.geology.unit !== baseGeology.unit;
    if(!different)return null;
    return {...candidate,score:95-candidate.distanceKm*2,
      objective:`Compare mapped units ${baseGeology.unit} / ${candidate.geology.unit}`,
      reason:`${baseGeology.description} → ${candidate.geology.description}. Compare surface texture or composition; the 1:20 million contact is approximate.`,
      kind:'unit-contact',unitCode:candidate.geology.unit,source:'USGS SIM 3292 geologic units',reference:GEOLOGY_SOURCE};
  }).filter(Boolean);
  const features=await nearbyMappedFeatures(origin,{fetcher,signal});
  const ranked=[...mappedUnits,...features].filter(candidate=>elevationAt(candidate.point,terrain)!==null)
    .sort((a,b)=>b.score-a.score||a.distanceKm-b.distanceKm);
  const selected=[];
  for (const candidate of ranked) {
    if(candidate.kind==='unit-contact'&&selected.some(item=>item.kind==='unit-contact'&&item.unitCode===candidate.unitCode))continue;
    const nearby=selected.some(item=>{
      const dx=(item.point.lon-candidate.point.lon)*Math.cos(origin.lat*Math.PI/180)*59.27;
      const dy=(item.point.lat-candidate.point.lat)*59.27;
      return Math.hypot(dx,dy)<.6;
    });
    if(!nearby)selected.push(candidate);
    if (selected.length===3) break;
  }
  return {baseGeology,targets:selected};
}
