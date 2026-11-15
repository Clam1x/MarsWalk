import test from 'node:test';
import assert from 'node:assert/strict';
import {suggestScienceStops} from '../src/science-stops.js';

const distances=Array.from({length:41},(_,i)=>i*.1);
const points=distances.map((_,i)=>({lat:0,lon:40+i*.001}));
const analysis={distances,elevations:distances.map((_,i)=>i===10?30:i===30?-20:0),distanceKm:4};
const segment=[{from:0,to:40,source:'hirise'}];
const response=unit=>({ok:true,json:async()=>({features:[{attributes:{Unit:unit,UnitDesc:unit==='A'?'plain':'fan'}}]})});

test('a route crossing mapped units receives a contact observation',async()=>{
  const stops=await suggestScienceStops(analysis,points,segment,{fetcher:async url=>{
    const lon=Number(new URL(url).searchParams.get('geometry').split(',')[0]);
    return response(lon<40.02?'A':'B');
  }});
  assert.equal(stops.length,1);
  assert.match(stops[0].objective,/A \/ B contact/);
  assert.match(stops[0].reason,/USGS SIM 3292/);
  assert.ok(stops[0].distanceKm>0&&stops[0].distanceKm<4);
});

test('elevation extremes and uniform geology do not become science stops',async()=>{
  const stops=await suggestScienceStops(analysis,points,segment,{fetcher:async()=>response('A')});
  assert.deepEqual(stops,[]);
});

test('unverified elevation at a mapped transition is not proposed',async()=>{
  const unverified=[{from:0,to:40,source:'unverified'}];
  const stops=await suggestScienceStops(analysis,points,unverified,{fetcher:async url=>{
    const lon=Number(new URL(url).searchParams.get('geometry').split(',')[0]);
    return response(lon<40.02?'A':'B');
  }});
  assert.deepEqual(stops,[]);
});
