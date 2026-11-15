import { destinationAt } from './mars-geometry.js';

const API='https://astrogeology.usgs.gov/pygeoapi/collections';
const R=3396.19, DEG=Math.PI/180;
const collections={structure:'mars/global_geologic_map/structure',contacts:'mars/global_geologic_map/contacts',craters:'mars/robbinsv1'};

function wrappedLongitude(lon){return ((lon+180)%360+360)%360-180;}
function localXY(point,origin){
  const lon=wrappedLongitude(point.lon-origin.lon);
  return {x:lon*DEG*R*Math.max(.01,Math.cos(origin.lat*DEG)),y:(point.lat-origin.lat)*DEG*R};
}
function pointFromXY(x,y,origin){
  return {lat:origin.lat+y/(DEG*R),lon:((origin.lon+x/(DEG*R*Math.max(.01,Math.cos(origin.lat*DEG))))%360+360)%360};
}
function nearestOnLine(origin,geometry){
  const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
  let best=null;
  for(const line of lines)for(let i=1;i<line.length;i++){
    const a=localXY({lon:line[i-1][0],lat:line[i-1][1]},origin);
    const b=localXY({lon:line[i][0],lat:line[i][1]},origin);
    const dx=b.x-a.x,dy=b.y-a.y,denominator=dx*dx+dy*dy;
    if(!denominator)continue;
    const t=Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/denominator));
    const x=a.x+t*dx,y=a.y+t*dy,distanceKm=Math.hypot(x,y);
    if(!best||distanceKm<best.distanceKm)best={point:pointFromXY(x,y,origin),distanceKm,x,y};
  }
  return best;
}

function localBboxes(origin,radiusKm){
  const halfLat=radiusKm/(R*DEG),halfLon=Math.min(10,halfLat/Math.max(.1,Math.cos(origin.lat*DEG)));
  const south=Math.max(-90,origin.lat-halfLat),north=Math.min(90,origin.lat+halfLat);
  const west=wrappedLongitude(origin.lon-halfLon),east=wrappedLongitude(origin.lon+halfLon);
  return west<=east?[[west,south,east,north]]:[[-180,south,east,north],[west,south,180,north]];
}

export async function nearbyMappedFeatures(origin,{fetcher=fetch,signal,radiusKm=6}={}){
  const results=[],bboxes=localBboxes(origin,Math.max(radiusKm,10));
  for(const [kind,collection] of Object.entries(collections)){
    for(const bbox of bboxes){
      const url=new URL(`${API}/${collection}/items`);
      url.search=new URLSearchParams({f:'json',bbox:bbox.join(','),limit:kind==='craters'?'50':'12'}).toString();
      let data;
      try{
        const timeout=AbortSignal.timeout(8000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
        const response=await fetcher(url.toString(),{signal:requestSignal});
        if(!response.ok)continue;
        data=await response.json();
      }catch(error){if(signal?.aborted)throw error;continue;}
      for(const feature of data.features??[]){
        const properties=feature.properties??{};
        if(kind==='craters'){
          const diameterKm=Number(properties.diamkm),center={lat:Number(properties.lat),lon:((Number(properties.lon_e)%360)+360)%360};
          if(!Number.isFinite(diameterKm)||diameterKm<1||diameterKm>20||!Number.isFinite(center.lat)||!Number.isFinite(center.lon))continue;
          const offset=localXY(center,origin),fromCenter=Math.hypot(offset.x,offset.y),rimKm=diameterKm/2;
          if(fromCenter<=rimKm+.5)continue; // Do not send a walker across a mapped crater rim.
          const targetKm=fromCenter-rimKm-.5;
          if(targetKm<.6||targetKm>radiusKm)continue;
          const bearing=(Math.atan2(offset.x,offset.y)/DEG+360)%360;
          results.push({point:destinationAt(origin,bearing,targetKm),distanceKm:targetKm,
            objective:`Inspect impact deposits at crater ${properties.craterid||feature.id}`,
            reason:`Mapped crater ${properties.craterid||feature.id}, ${diameterKm.toFixed(1)} km diameter. Target is outside its nominal rim; inspect imagery and terrain before field work.`,
            source:'USGS Robbins V1 crater catalog',reference:`${API}/${collection}/items/${feature.id}?f=html`,kind:'crater',score:70-targetKm*2});
          continue;
        }
        const nearest=nearestOnLine(origin,feature.geometry);
        if(!nearest||nearest.distanceKm<1.1||nearest.distanceKm>radiusKm+.6)continue;
        const targetKm=nearest.distanceKm-.6;
        if(targetKm<.6||targetKm>radiusKm)continue;
        const bearing=(Math.atan2(nearest.x,nearest.y)/DEG+360)%360;
        const point=destinationAt(origin,bearing,targetKm);
        if(kind==='structure'){
          const interpretation=String(properties.interpreta||'').trim();
          if(!/channel|graben|ridge|fault|scarp|fracture|trough|valley|dike/i.test(interpretation)||/buried/i.test(properties.preservati||'')&&!/partly/i.test(properties.preservati||''))continue;
          results.push({point,distanceKm:targetKm,objective:`Document mapped ${interpretation.toLowerCase()}`,
            reason:`USGS structure ${feature.id}: ${properties.origin||'unknown origin'}; ${properties.preservati||'preservation unknown'}. Proposed observation is ~0.6 km from the mapped line, whose position is regional-scale.`,
            source:'USGS SIM 3292 structure',reference:`${API}/${collection}/items/${feature.id}?f=html`,kind:'structure',score:85-targetKm*2});
        }else{
          results.push({point,distanceKm:targetKm,objective:`Compare materials at mapped contact ${feature.id}`,
            reason:`USGS contact ${feature.id} (${properties.contype||'certainty unspecified'}). Compare surface material on the two sides; contact position is regional-scale.`,
            source:'USGS SIM 3292 contacts',reference:`${API}/${collection}/items/${feature.id}?f=html`,kind:'contact',score:60-targetKm*2});
        }
      }
    }
  }
  return results;
}
