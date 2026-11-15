// Adjustable planning slowdown. It is not a measured EVA speed model.
export function estimateTravelTime(analysis,speedKmh,{slowdownAt12Deg=.5}={}){
  if(!Number.isFinite(speedKmh)||speedKmh<=0||!Number.isFinite(slowdownAt12Deg)||slowdownAt12Deg<0)throw new RangeError('Invalid travel-time assumptions');
  const distances=analysis?.distances??[],elevations=analysis?.elevations??[];
  if(!distances.length||distances.length!==elevations.length)throw new RangeError('Route profile is unavailable');
  const timeHours=[0];let unknownKm=0,maxFactor=1;
  for(let i=1;i<distances.length;i++){
    const lengthKm=distances[i]-distances[i-1];if(!Number.isFinite(lengthKm)||lengthKm<0)throw new RangeError('Invalid route distances');
    const measured=Number.isFinite(elevations[i])&&Number.isFinite(elevations[i-1])&&lengthKm>0;
    const slope=measured?Math.atan2(Math.abs(elevations[i]-elevations[i-1]),lengthKm*1000)*180/Math.PI:0;
    const factor=1+Math.min(2,slowdownAt12Deg*(slope/12)**2);
    if(!measured&&lengthKm>0)unknownKm+=lengthKm;
    maxFactor=Math.max(maxFactor,factor);
    timeHours.push(timeHours.at(-1)+lengthKm/speedKmh*factor);
  }
  return {hours:timeHours.at(-1),distances:[...distances],timeHours,unknownKm,maxFactor,assumption:'Slope slowdown is a user-adjustable planning assumption; foot-scale roughness and fatigue are not measured.'};
}

export function timeAtDistance(profile,distanceKm){
  const {distances,timeHours}=profile;
  if(distanceKm<=0)return 0;
  for(let i=1;i<distances.length;i++)if(distanceKm<=distances[i]){
    const span=distances[i]-distances[i-1];
    return timeHours[i-1]+(span?(distanceKm-distances[i-1])/span*(timeHours[i]-timeHours[i-1]):0);
  }
  return profile.hours;
}
