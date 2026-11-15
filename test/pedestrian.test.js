import test from 'node:test';
import assert from 'node:assert/strict';
import {pedestrianCellFilter} from '../src/pedestrian.js';

test('pedestrian corridor rejects a side hazard missed by point-to-point slope',()=>{
  const terrain={width:5,height:5,cellKm:.001,elevation:new Float32Array(25).fill(100),noData:-32768};
  const centre=2*5+2;
  assert.equal(pedestrianCellFilter(terrain,{radiusM:1,slopeLimit:12})(centre),true);
  terrain.elevation[centre+5]=103;
  assert.equal(pedestrianCellFilter(terrain,{radiusM:1,slopeLimit:12})(centre),false);
  terrain.elevation[centre+5]=-32768;
  assert.equal(pedestrianCellFilter(terrain,{radiusM:1,slopeLimit:12})(centre),false);
});
