const RADIUS_M=3396190,RAD=Math.PI/180;
const lonDelta=(a,b)=>((a-b+540)%360)-180;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function pointSegmentDistance(x,y,a,b){
  const dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
  const t=length?clamp(((x-a.x)*dx+(y-a.y)*dy)/length,0,1):0;
  return Math.hypot(x-a.x-t*dx,y-a.y-t*dy);
}

export function toLocal(point,origin){
  return {x:lonDelta(point.lon,origin.lon)*RAD*RADIUS_M*Math.cos(origin.lat*RAD),
    y:(point.lat-origin.lat)*RAD*RADIUS_M};
}
export function clearanceRadius(hazard,settings={}){
  return hazard.radiusM+Math.max(0,settings.vehicleRadiusM??1)+Math.max(0,hazard.contourErrorM??0);
}
export function edgeHitsHazard(a,b,hazard,settings={}){
  const p=toLocal(a,hazard),q=toLocal(b,hazard);
  return pointSegmentDistance(0,0,p,q)<=clearanceRadius(hazard,settings);
}
function distanceKm(a,b){
  const dLat=(b.lat-a.lat)*RAD,dLon=lonDelta(b.lon,a.lon)*RAD;
  const value=Math.sin(dLat/2)**2+Math.cos(a.lat*RAD)*Math.cos(b.lat*RAD)*Math.sin(dLon/2)**2;
  return 2*RADIUS_M/1000*Math.asin(Math.sqrt(Math.min(1,Math.max(0,value))));
}

export function rebuildRouteQuality(points,elevations){
  const distances=[0],segments=[];let elevationGain=0,maxSlope=0,unverifiedKm=0,unverifiedJoinKm=0;
  for(let index=1;index<points.length;index++){
    const previous=points[index-1],current=points[index],length=distanceKm(previous,current);
    distances.push(distances.at(-1)+length);
    const sourceUnknown=previous.source==='unverified'||current.source==='unverified';
    const modelJoin=(previous.modelId??null)!==(current.modelId??null)||
      (previous.source!==current.source&&['ctx','hirise'].some(id=>previous.source===id||current.source===id));
    const unknown=sourceUnknown||modelJoin;
    const source=unknown?'unverified':current.source,modelId=unknown?null:current.modelId??null;
    const spacingM=unknown?null:current.spacingM??null;
    if(unknown){unverifiedKm+=length;if(modelJoin)unverifiedJoinKm+=length;}
    let segment=segments.at(-1);
    if(!segment||segment.source!==source||segment.modelId!==modelId||segment.spacingM!==spacingM){
      segment={source,modelId,spacingM,from:index-1,to:index,distanceKm:0};segments.push(segment);
    }
    segment.to=index;segment.distanceKm+=length;
    if(!unknown&&Number.isFinite(elevations[index-1])&&Number.isFinite(elevations[index])&&length>0){
      const rise=elevations[index]-elevations[index-1];
      if(rise>0)elevationGain+=rise;
      maxSlope=Math.max(maxSlope,Math.atan2(Math.abs(rise)/1000,length)*180/Math.PI);
    }
  }
  const transitions=segments.slice(1).map(segment=>({index:segment.from,point:points[segment.from],source:segment.source}));
  return {segments,transitions,analysis:{distanceKm:distances.at(-1)??0,elevationGain,maxSlope,elevations,distances},unverifiedKm,unverifiedJoinKm};
}
