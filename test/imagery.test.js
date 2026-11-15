import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { imageryLayers, tileUrl, tileZoom, visibleTiles } from '../src/imagery.js';

const global = {west:0,east:360,south:-90,north:90};
const frame = {x:0,y:0,w:800,h:400};

test('planet-wide tiles cross the 180-degree seam without reversing map positions', () => {
  for(const layer of ['viking','ctx','hirise']){
    const tiles=visibleTiles(layer,global,frame,{width:800,height:400},0);
    assert.equal(tiles.length,layer==='ctx'?2:2);
    assert.deepEqual(tiles.map(t=>t.col),[1,0]);
    assert.deepEqual(tiles.map(t=>t.x),[0,400]);
  }
});

test('CTX coverage stops at the documented polar boundary', () => {
  const tiles=visibleTiles('ctx',global,frame,{width:800,height:4},4);
  assert.deepEqual(tiles,[]);
});

test('USGS geology tiles follow the 360-degree ArcGIS grid and align across 180°',()=>{
  const tiles=visibleTiles('geology',global,frame,{width:800,height:400},2);
  assert.equal(tiles.length,8);
  assert.deepEqual(tiles.filter(tile=>tile.row===1).map(tile=>tile.col),[2,3,0,1]);
  assert.deepEqual(tiles.filter(tile=>tile.row===1).map(tile=>tile.x),[0,200,400,600]);
  assert.deepEqual([...new Set(tiles.map(tile=>tile.y))],[0,200]);
  assert.equal(tileZoom(800,360,6,256,360),2);
  assert.match(tileUrl('geology',2,2,2),/Mars_geology_All_layers_100pct\/MapServer\/tile\/2\/2\/2$/);
});

test('zoom and service URLs follow each provider tile scheme', () => {
  assert.equal(tileZoom(800,360,7,256),1);
  assert.equal(tileZoom(800,360,17,512),0);
  assert.match(tileUrl('viking',0,0,1),/trek\.nasa\.gov.*\/0\/0\/1\.jpg$/);
  assert.match(tileUrl('ctx',0,0,1),/CTX1\/MapServer\/tile\/0\/0\/1$/);
  assert.match(tileUrl('hirise',0,0,1),/HiRISE\/MapServer\/tile\/0\/0\/1$/);
  assert.throws(()=>tileUrl('hirise',18,0,0));
});

test('every bundled overview tile has a real image file and source record', async () => {
  const index=JSON.parse(await readFile(new URL('../data/imagery-index.json',import.meta.url),'utf8'));
  assert.equal(Object.keys(index.files).length,126);
  for(const layer of Object.keys(imageryLayers).filter(layer=>layer!=='geology'))assert.ok(index.sources[layer]?.url);
  for(const path of Object.values(index.files)){
    const file=new URL(`../data/imagery/${path}`,import.meta.url);
    const info=await stat(file);assert.ok(info.size>100);
    const bytes=new Uint8Array(await readFile(file));
    assert.ok(bytes[0]===0xff&&bytes[1]===0xd8 || bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e);
  }
});
