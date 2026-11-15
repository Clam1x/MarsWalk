export function niceScaleBar(kmPer80px) {
  if(!Number.isFinite(kmPer80px)||kmPer80px<=0)return {distanceKm:0,widthPx:80,label:'—'};
  const exponent=Math.floor(Math.log10(kmPer80px));
  let best=null;
  for(let power=exponent-1;power<=exponent+1;power++)for(const step of [1,2,5,10]){
    const distanceKm=step*10**power,widthPx=80*distanceKm/kmPer80px;
    if(widthPx<55||widthPx>150)continue;
    const score=Math.abs(Math.log(widthPx/90));
    if(!best||score<best.score)best={distanceKm,widthPx,score};
  }
  if(!best)best={distanceKm:kmPer80px,widthPx:80};
  const metres=best.distanceKm*1000;
  const label=best.distanceKm>=1?`${best.distanceKm} km`:metres>=1?`${Math.round(metres*10)/10} m`:`${Math.round(metres*10000)/100} cm`;
  return {distanceKm:best.distanceKm,widthPx:best.widthPx,label:`≈${label}`};
}
