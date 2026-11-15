const RADIUS_KM=3396.19;
const radians=Math.PI/180;

function distanceKm(a,b){
  const dLat=(b.lat-a.lat)*radians,dLon=(b.lon-a.lon)*radians;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat*radians)*Math.cos(b.lat*radians)*Math.sin(dLon/2)**2;
  return 2*RADIUS_KM*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}

export function stitchLocalPatches(base,patches){
  if(!patches.length)return {...base,localModels:[],demHazards:[],demAvoided:[],demUnresolved:[],
    demSurvey:{available:false,testedCenters:0,truncated:false}};
  const points=[],elevations=[],localModels=[],demHazards=[],demAvoided=[],demUnresolved=[];
  let demTestedCenters=0,demTruncated=false;
  let cursor=0,loadedCells=base.loadedCells,explored=base.explored;
  for(const patch of patches){
    if(patch.from<cursor||patch.to>=base.points.length||patch.route.points.length<2)continue;
    points.push(...base.points.slice(cursor,patch.from).map(point=>({...point,spacingM:base.spacingM})));
    elevations.push(...base.analysis.elevations.slice(cursor,patch.from));
    points.push(...patch.route.points);
    elevations.push(...patch.route.analysis.elevations);
    localModels.push({source:patch.model.source,id:patch.model.id,spacingM:patch.route.spacingM,footprint:patch.route.footprint});
    demHazards.push(...(patch.route.demHazards??[]));
    demAvoided.push(...(patch.route.demAvoided??[]));
    demUnresolved.push(...(patch.route.demUnresolved??[]));
    demTestedCenters+=patch.route.demSurvey?.testedCenters??0;
    demTruncated ||= patch.route.demSurvey?.truncated??false;
    loadedCells+=patch.route.loadedCells;explored+=patch.route.explored;
    cursor=patch.to+1;
  }
  points.push(...base.points.slice(cursor).map(point=>({...point,spacingM:base.spacingM})));
  elevations.push(...base.analysis.elevations.slice(cursor));
  const distances=[0],segments=[];
  let elevationGain=0,maxSlope=0;
  for(let index=1;index<points.length;index++){
    const length=distanceKm(points[index-1],points[index]);
    distances.push(distances.at(-1)+length);
    const source=points[index].source,modelId=points[index].modelId??null,spacingM=points[index].spacingM;
    // Leave a visible break at independent model seams in the colored route
    // and profile rather than drawing an apparent physical cliff.
    const localEdge=points[index-1].source==='ctx'||points[index-1].source==='hirise'||source==='ctx'||source==='hirise';
    const seam=localEdge&&(points[index-1].source!==source||(points[index-1].modelId??null)!==modelId);
    let segment=segments.at(-1);
    if(!segment||segment.source!==source||segment.modelId!==modelId||segment.spacingM!==spacingM){segment={source,modelId,spacingM,from:seam?index:index-1,to:index,distanceKm:0};segments.push(segment);}
    segment.to=index;segment.distanceKm+=length;
    // Independent stereo products may have a vertical registration offset.
    // Do not count the seam as a physical slope or climb.
    if(!seam&&length>0){
      const rise=elevations[index]-elevations[index-1];
      if(rise>0)elevationGain+=rise;
      maxSlope=Math.max(maxSlope,Math.atan2(Math.abs(rise)/1000,length)*180/Math.PI);
    }
  }
  const transitions=segments.slice(1).map(segment=>({index:segment.from,point:points[segment.from],source:segment.source}));
  const analysis={distanceKm:distances.at(-1),elevationGain,maxSlope,elevations,distances};
  return {points,analysis,segments,transitions,explored,loadedCells,spacingM:base.spacingM,pathLength:points.length,localModels,
    demHazards,demAvoided,demUnresolved,demSurvey:{available:localModels.length>0,testedCenters:demTestedCenters,
      truncated:demTruncated}};
}
