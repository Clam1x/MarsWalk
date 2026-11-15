import test from 'node:test';
import assert from 'node:assert/strict';
import { destinationAt, geologyAt, suggestGlobalScienceTargets } from '../src/science-targets.js';

const terrain={width:360,height:180,bounds:{north:90,south:-90,west:0,east:360},
  elevation:Float32Array.from({length:360*180},(_,index)=>Math.floor(index/360)*20+index%360)};
const origin={lat:0,lon:40};

test('global geology requests normalize 0–360 longitude and identify mapped units',async()=>{
  let queried;
  const fetcher=async url=>{queried=new URL(url);return {ok:true,json:async()=>({features:[{attributes:{Unit:'A',UnitDesc:'plain'}}]})};};
  assert.equal((await geologyAt({lat:-5,lon:300},fetcher)).unit,'A');
  assert.equal(queried.searchParams.get('geometry'),'-60.000000,-5.000000');
});

test('science targets prefer a nearby mapped geologic transition',async()=>{
  const fetcher=async url=>{
    if(url.includes('pygeoapi'))return {ok:true,json:async()=>({features:[]})};
    const lon=Number(new URL(url).searchParams.get('geometry').split(',')[0]);
    const different=lon>40.02;
    return {ok:true,json:async()=>({features:[{attributes:{Unit:different?'B':'A',UnitDesc:different?'fan':'plain'}}]})};
  };
  const {baseGeology,targets}=await suggestGlobalScienceTargets(origin,terrain,{fetcher});
  assert.equal(baseGeology.unit,'A');
  assert.equal(targets.length,1);
  assert.equal(targets[0].kind,'unit-contact');
  assert.match(targets[0].objective,/A \/ B/);
});

test('unavailable geology does not create a generic elevation target',async()=>{
  const {targets}=await suggestGlobalScienceTargets({lat:-30,lon:358},terrain,{fetcher:async()=>{throw Error('offline')}});
  assert.deepEqual(targets,[]);
  assert.ok(destinationAt({lat:0,lon:359.99},90,5).lon<1);
});

test('a mapped fluvial channel creates a specific goal without a manual B',async()=>{
  const fetcher=async url=>{
    if(url.includes('/structure/'))return {ok:true,json:async()=>({features:[{id:7,properties:{interpreta:'Channel axis',origin:'Fluvial',preservati:'Subdued'},geometry:{type:'LineString',coordinates:[[40.05,-.02],[40.05,.02]]}}]})};
    if(url.includes('pygeoapi'))return {ok:true,json:async()=>({features:[]})};
    return {ok:true,json:async()=>({features:[{attributes:{Unit:'A',UnitDesc:'plain'}}]})};
  };
  const {targets}=await suggestGlobalScienceTargets(origin,terrain,{fetcher});
  assert.equal(targets[0].kind,'structure');
  assert.match(targets[0].objective,/channel axis/);
  assert.ok(targets[0].distanceKm>1);
});

test('a mapped crater creates an observation goal outside its nominal rim',async()=>{
  const fetcher=async url=>{
    if(url.includes('/robbinsv1/'))return {ok:true,json:async()=>({features:[{id:44,properties:{craterid:'13-0044',lat:0,lon_e:40.05,diamkm:2},geometry:{type:'Point',coordinates:[40.05,0]}}]})};
    if(url.includes('pygeoapi'))return {ok:true,json:async()=>({features:[]})};
    return {ok:true,json:async()=>({features:[{attributes:{Unit:'A',UnitDesc:'plain'}}]})};
  };
  const {targets}=await suggestGlobalScienceTargets(origin,terrain,{fetcher});
  assert.equal(targets[0].kind,'crater');
  assert.match(targets[0].objective,/13-0044/);
  assert.ok(targets[0].distanceKm>1&&targets[0].distanceKm<2);
});
