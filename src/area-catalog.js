const API='https://stac.astrogeology.usgs.gov/api/search';
export const areaCollections={ctx:'mro_ctx_controlled_usgs_dtms',hirise:'mro_hirise_socet_dtms'};

function inRing(point,ring){
  let inside=false;
  for(let index=0,previous=ring.length-1;index<ring.length;previous=index++){
    const a=ring[index],b=ring[previous];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
export function pointInGeometry(lon,lat,geometry){
  const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.some(polygon=>inRing([lon,lat],polygon[0])&&!polygon.slice(1).some(hole=>inRing([lon,lat],hole)));
}

// The map is 0–360° east. STAC uses signed −180–180° longitude.
export function catalogBboxes(bounds){
  const south=Math.max(-90,Math.min(90,bounds.south));
  const north=Math.max(-90,Math.min(90,bounds.north));
  if(!(bounds.east>bounds.west&&north>south))return [];
  const intervals=[[Math.max(0,bounds.west),Math.min(180,bounds.east),0],
    [Math.max(180,bounds.west),Math.min(360,bounds.east),-360]];
  return intervals.filter(([west,east])=>east>west).map(([west,east,shift])=>[west+shift,south,east+shift,north]);
}

export async function fetchAreaFootprints(source,bounds,{fetcher=fetch,signal}={}){
  const collection=areaCollections[source];
  if(!collection)throw new Error('Unknown terrain model source');
  const bboxes=catalogBboxes(bounds);
  const parts=await Promise.all(bboxes.map(async bbox=>{
    const url=new URL(API);
    url.searchParams.set('collections',collection);
    url.searchParams.set('bbox',bbox.join(','));
    url.searchParams.set('limit','500');
    const features=[];
    let matched=null,next=url,truncated=false;
    const seen=new Set();
    for(let page=0;page<8&&next;page++){
      if(seen.has(next.toString())){truncated=true;break;}
      seen.add(next.toString());
      const response=await fetcher(next,{signal});
      if(!response.ok)throw new Error(`USGS ${source.toUpperCase()} footprint catalogue is unavailable`);
      const body=await response.json(),batch=body.features??[];
      matched??=Number.isFinite(body.numberMatched)?body.numberMatched:null;
      features.push(...batch);
      const nextHref=body.links?.find(link=>link.rel==='next')?.href;
      if(!nextHref){
        truncated=matched!=null?features.length<matched:batch.length>=500;
        next=null;break;
      }
      const cursor=new URL(nextHref).searchParams.get('next');
      if(!cursor){truncated=true;next=null;break;}
      next=new URL(url);next.searchParams.set('next',cursor);
    }
    if(next)truncated=true;
    return {features,matched:matched??features.length,truncated};
  }));
  const byId=new Map();
  for(const part of parts)for(const feature of part.features)if(feature.id&&feature.geometry)byId.set(feature.id,{id:feature.id,source,geometry:feature.geometry,bbox:feature.bbox,gsd:Number(feature.properties?.gsd)});
  return {features:[...byId.values()],matched:parts.reduce((total,part)=>total+part.matched,0),truncated:parts.some(part=>part.truncated)};
}
