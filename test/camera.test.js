import test from 'node:test';
import assert from 'node:assert/strict';
import { MapCamera, parseCoordinates } from '../src/camera.js';
test('zoom keeps pointer position anchored and coordinate transforms round trip',()=>{
  const c=new MapCamera();c.resize(900,500,2);const p=c.screenToWorld(400,250);c.zoomAt(2,400,250);const q=c.screenToWorld(400,250);
  assert.ok(Math.abs(p.x-q.x)<1e-10);assert.ok(Math.abs(p.y-q.y)<1e-10);
  const s=c.worldToScreen(q.x,q.y);assert.ok(Math.abs(s.x-400)<1e-10);assert.ok(Math.abs(s.y-250)<1e-10);
  c.pan(1e6,1e6);const f=c.frame;assert.ok(f.x<=1e-9&&f.x+f.w>=900);assert.ok(f.y<=1e-9&&f.y+f.h>=500);
  c.reset();assert.equal(c.zoom,1);assert.equal(c.cx,.5);
});
test('coordinate search validates input and converts west longitudes',()=>{
  assert.deepEqual(parseCoordinates('18.65, -133.8'),{lat:18.65,lon:226.2});
  for(const s of ['',',','10,','NaN, 10','91, 77','10, 400','18, 77, 2'])assert.equal(parseCoordinates(s),null);
});
