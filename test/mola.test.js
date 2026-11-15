import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeTerrain } from '../src/nasa-adapter.js';
import { gridToMarsCoordinate } from '../src/terrain.js';

async function dataset(id) {
  const m=JSON.parse(await readFile(new URL(`../data/${id}.json`,import.meta.url)));
  const b=await readFile(new URL(`../data/${id}.bin`,import.meta.url));
  assert.equal(createHash('sha256').update(b).digest('hex'),m.sha256);
  return decodeTerrain(m,b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
}
test('NASA global image: checksum, byte order, dimensions and plausible heights',async()=>{
  const t=await dataset('mars-global');assert.equal(t.width,1440);assert.equal(t.height,720);assert.ok(t.min < -7000);assert.ok(t.max>20000&&t.max<22000);
  assert.deepEqual(gridToMarsCoordinate(0,0,t),{lat:89.875,lon:.125});
  assert.deepEqual(gridToMarsCoordinate(1439,719,t),{lat:-89.875,lon:359.875});
});
test('malformed elevation file and invalid bounds are rejected',()=>{
  const m={width:2,height:2,encoding:'int16-be',radiusKm:3396,bounds:{west:0,east:2,south:0,north:2}};
  assert.throws(()=>decodeTerrain(m,new ArrayBuffer(2)),/file/);
  assert.throws(()=>decodeTerrain({...m,bounds:{west:0,east:0,south:0,north:2}},new ArrayBuffer(8)),/coordinates/);
  const bytes=new ArrayBuffer(8),v=new DataView(bytes);for(let i=0;i<4;i++)v.setInt16(i*2,-32768,false);
  assert.throws(()=>decodeTerrain({...m,noData:-32768},bytes),/no valid/);
});
