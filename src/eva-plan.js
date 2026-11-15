import {timeAtDistance} from './travel-time.js';

// This is a time and consumables worksheet, not an EVA safety model.
export function planEVA({distanceKm, speedKmh, returnToStart, stops, budgets, reservePercent,travelProfile=null}) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0 || !Number.isFinite(speedKmh) || speedKmh <= 0) throw new RangeError('Valid route distance and walking speed are required.');
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent >= 100) throw new RangeError('Reserve must be between 0 and 99 percent.');
  const sorted = [...stops].sort((a,b)=>a.distanceKm-b.distanceKm);
  for (const stop of sorted) if (!Number.isFinite(stop.distanceKm) || stop.distanceKm < 0 || stop.distanceKm > distanceKm || !Number.isFinite(stop.minutes) || stop.minutes < 0) throw new RangeError('Science stop is outside the route or has an invalid duration.');
  const walkHours = travelProfile?.hours??distanceKm/speedKmh;
  const workHours = sorted.reduce((sum,stop)=>sum+stop.minutes/60,0);
  const totalHours = walkHours * (returnToStart ? 2 : 1) + workHours;
  const resources = Object.fromEntries(Object.entries(budgets).map(([name,hours])=>{
    if (hours === null || hours === '') return [name,{status:'unknown',remainingHours:null}];
    const value = Number(hours);
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Resource duration must be a nonnegative number.');
    const remainingHours = value*(1-reservePercent/100)-totalHours;
    return [name,{status:remainingHours>=0?'within':'over',remainingHours}];
  }));
  let elapsedWorkHours=0;
  const itinerary = sorted.map(stop=>{
    const item={...stop,arrivalHours:(travelProfile?timeAtDistance(travelProfile,stop.distanceKm):stop.distanceKm/speedKmh)+elapsedWorkHours};
    elapsedWorkHours+=stop.minutes/60;
    return item;
  });
  return {walkHours,workHours,totalHours,returnHours:returnToStart?walkHours:0,resources,itinerary};
}
