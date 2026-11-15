const RADIUS_KM=3396.19,DEG=Math.PI/180;

export function destinationAt(origin,bearingDeg,distanceKm){
  const lat1=origin.lat*DEG,lon1=origin.lon*DEG,bearing=bearingDeg*DEG,angle=distanceKm/RADIUS_KM;
  const lat=Math.asin(Math.sin(lat1)*Math.cos(angle)+Math.cos(lat1)*Math.sin(angle)*Math.cos(bearing));
  const lon=lon1+Math.atan2(Math.sin(bearing)*Math.sin(angle)*Math.cos(lat1),Math.cos(angle)-Math.sin(lat1)*Math.sin(lat));
  return {lat:lat/DEG,lon:((lon/DEG%360)+360)%360};
}
