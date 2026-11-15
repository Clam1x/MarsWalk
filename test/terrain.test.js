import test from 'node:test';
import assert from 'node:assert/strict';
import { coordinateToGrid, gridToMarsCoordinate, terrainDistanceKm, terrainSlopeDegrees } from '../src/terrain.js';

test('slope is zero on level terrain', () => {
  const terrain = {width:2,height:1,elevation:new Float32Array([100,100]),cellKm:0.1};
  assert.equal(terrainSlopeDegrees(terrain,0,1),0);
});

test('planet-wide coordinates map to cell centers', () => {
  const terrain = {width:5760,height:2880,bounds:{west:0,east:360,north:90,south:-90},radiusKm:3396};
  const cell = coordinateToGrid(15.4,131.7,terrain);
  const center = gridToMarsCoordinate(cell.x,cell.y,terrain);
  assert.ok(Math.abs(center.lat-15.4)<1/16);
  assert.ok(Math.abs(center.lon-131.7)<1/16);
  assert.equal(coordinateToGrid(91,131.7,terrain),null);
});

test('adjacent cells across the global longitude seam are nearby', () => {
  const terrain = {width:5760,height:2880,bounds:{west:0,east:360,north:90,south:-90},radiusKm:3396,wrapLongitude:true};
  const row = 1440;
  assert.ok(terrainDistanceKm(terrain,row*terrain.width+5759,row*terrain.width)<4);
});
