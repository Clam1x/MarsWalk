import { geologyAt } from './science-targets.js';

// A science stop requires a mapped geologic change. Elevation extrema alone are not objectives.
export async function suggestScienceStops(analysis,points,segments=[],{maxStops=3,workMinutes=20,fetcher=fetch,signal}={}){
  const distances=analysis?.distances??[],total=analysis?.distanceKm??0;
  if(points.length<3||distances.length!==points.length||total<=0)return [];
  const sampleIndices=[];
  for(let n=0;n<=16;n++){
    const target=total*n/16;
    let low=0,high=distances.length-1;
    while(low<high){const mid=Math.floor((low+high)/2);if(distances[mid]<target)low=mid+1;else high=mid;}
    if(!sampleIndices.includes(low))sampleIndices.push(low);
  }
  const observations=[];
  for(let i=0;i<sampleIndices.length;i+=4){
    const batch=sampleIndices.slice(i,i+4);
    observations.push(...await Promise.all(batch.map(async index=>({index,geology:await geologyAt(points[index],fetcher,signal)}))));
  }
  const stops=[];
  for(let i=1;i<observations.length;i++){
    const previous=observations[i-1],current=observations[i];
    if(!previous.geology||!current.geology||previous.geology.unit===current.geology.unit)continue;
    const index=current.index,distanceKm=distances[index];
    if(distanceKm<total*.08||distanceKm>total*.92)continue;
    const segment=segments.find(item=>index>=item.from&&index<=item.to);
    if(segment?.source==='unverified'||!Number.isFinite(analysis.elevations?.[index]))continue;
    if(stops.some(item=>Math.abs(item.distanceKm-distanceKm)<Math.max(.15,total*.1)))continue;
    stops.push({objective:`Compare ${previous.geology.unit} / ${current.geology.unit} contact`,
      reason:`USGS SIM 3292 maps ${previous.geology.description} beside ${current.geology.description}; document material differences. Contact position is approximate.`,
      minutes:workMinutes,distanceKm,point:points[index],proposed:true,source:'USGS SIM 3292'});
    if(stops.length===maxStops)break;
  }
  return stops;
}
