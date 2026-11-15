import test from 'node:test';
import assert from 'node:assert/strict';
import {localPathEvidence,annotateRouteSegments} from '../src/route-evidence.js';

test('quality evidence refuses missing provenance and image registration',()=>{
  const terrain={width:7,height:7,elevation:new Float32Array(49).fill(0),noData:-32768};
  const path=[24,25];
  const unknown=localPathEvidence(terrain,path,{qualityAssets:{ortho:'image'}});
  assert.equal(unknown.status,'uncertain');
  assert.ok(unknown.reasons.includes('pixel provenance / interpolation unavailable'));
  assert.ok(unknown.reasons.includes('image–terrain agreement unmeasured'));
  terrain.elevation[17]=-32768;
  assert.ok(localPathEvidence(terrain,path,{qualityAssets:{}}).reasons.includes('route approaches missing DTM heights'));
});

test('each section carries its own source uncertainty',()=>{
  const segments=annotateRouteSegments([
    {source:'mola',from:0,to:2},{source:'hirise',modelId:'a',from:2,to:4}],
    new Map([['a',{reasons:['model edge']}]]));
  assert.match(segments[0].evidence.reasons.join(' '),/coarser/);
  assert.deepEqual(segments[1].evidence.reasons,['model edge']);
});
