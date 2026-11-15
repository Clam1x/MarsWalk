import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateTravelTime,timeAtDistance} from '../src/travel-time.js';
import {marsSolar,evaluateMissionConditions} from '../src/mars-environment.js';

test('measured slope slows the itinerary without inventing heights in gaps',()=>{
  const profile=estimateTravelTime({distances:[0,.1,.2,.3],elevations:[0,20,20,NaN]},2);
  assert.ok(profile.hours>.15);
  assert.equal(profile.unknownKm,.3-.2);
  assert.ok(timeAtDistance(profile,.15)>profile.timeHours[1]);
});

test('Mars24 worked example places the sun below the horizon at prime-meridian midnight',()=>{
  const sun=marsSolar('2000-01-06T00:00:00Z',0,0);
  assert.ok(Math.abs(sun.trueSolarHour-23.6484)<.02);
  assert.ok(Math.abs(sun.elevationDeg+64.2618)<.2);
});

test('environment separates calculated sunlight from entered forecast and radio assumptions',()=>{
  const profile={hours:1,distances:[0,1],timeHours:[0,1]};
  const result=evaluateMissionConditions({startUTC:'2026-11-08T00:00:00Z',points:[{lat:0,lon:0},{lat:0,lon:.017}],
    travelProfile:profile,totalHours:2,returnToStart:true,radiationRate:1,doseLimit:1,
    radioRangeKm:1,baseAntennaM:2,suitAntennaM:2});
  assert.equal(result.temperature.status,'unknown');
  assert.equal(result.weather.status,'unknown');
  assert.equal(result.radiation.status,'over');
  assert.equal(result.communications.status,'geometry_over');
  assert.ok(Number.isFinite(result.sunlight.minimumElevationDeg));
});
