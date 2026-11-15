import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findRoute, analyzeRoute } from '../src/astar.js';
import { maskContains, chooseBlendGrid, routeCorridor, blendGrid, classifyRoute, loadBlendCorridor, BLEND } from '../src/blend-dem.js';

test('published HRSC footprint guide is nonempty, limited, and aligned to geographic coordinates', async () => {
  const meta=JSON.parse(await readFile(new URL('../data/hrsc-coverage.json',import.meta.url)));
  const bytes=new Uint8Array(await readFile(new URL('../data/hrsc-coverage.bin',import.meta.url)));
  assert.equal(bytes.length,meta.width*meta.height/8);
  assert.deepEqual(meta.pdfMapFrame,[96.241,45.182,1223.766,608.893]);
  assert.ok(meta.approxAreaFraction>.42&&meta.approxAreaFraction<.48);
  const mask={width:meta.width,height:meta.height,bytes};
  assert.equal(maskContains(mask,0,0),maskContains(mask,0,360));
  assert.equal(maskContains(mask,60,0),false);
  assert.equal(maskContains(mask,0,120),true);
});

test('route corridor stays narrow across the 0°/360° seam', () => {
  const grid=blendGrid(8);
  const rows=routeCorridor([{lat:1,lon:359.98},{lat:1.01,lon:.02}],grid,2);
  assert.ok(rows.size>0&&rows.size<40);
  const intervals=[...rows.values()].flat();
  assert.ok(intervals.some(([a])=>a===0));
  assert.ok(intervals.some(([,b])=>b===grid.width-1));
  assert.ok(intervals.every(([a,b])=>b-a<100));
});

test('200 m requirement accepts a local route, and rejects coarsened long routes', () => {
  const local=chooseBlendGrid([{lat:0,lon:10},{lat:.02,lon:10.02}],200);
  assert.equal(local.grid.stride,1);
  assert.ok(local.spacingM>199&&local.spacingM<201);
  assert.throws(()=>chooseBlendGrid([{lat:-5,lon:10},{lat:5,lon:10}],200),/cannot be loaded/);
});

test('adjacent DEM rows share one range request without changing heights', async () => {
  const grid=blendGrid(1),rows=new Map([0,1,2].map(y=>[y,[[0,1]]]));
  let requests=0;
  const fetcher=async(_url,{headers})=>{
    requests++;
    const [start,end]=headers.Range.match(/\d+/g).map(Number);
    const bytes=new Uint8Array(end-start+1),view=new DataView(bytes.buffer);
    for(let y=0;y<3;y++)for(let x=0;x<2;x++){
      const column=x+BLEND.width/2;
      const offset=BLEND.rowOffset+y*BLEND.rowBytes+column*2-start;
      view.setInt16(offset,100+y*10+x,true);
    }
    return {status:206,arrayBuffer:async()=>bytes.buffer};
  };
  const terrain=await loadBlendCorridor({grid,rows},{fetcher,verifySource:async()=>true});
  assert.equal(requests,1);
  assert.equal(terrain.loadedCells,6);
  for(let y=0;y<3;y++)for(let x=0;x<2;x++)assert.equal(terrain.heightAt(y*grid.width+x),100+y*10+x);
});

test('sparse A* routes around missing heights and preserves elevation analysis', () => {
  const heights=new Map();
  for(let y=0;y<5;y++)for(let x=0;x<5;x++)if(!(x===2&&y<4))heights.set(y*5+x,100+y*10);
  const terrain={width:5,height:5,cellKm:1,radiusKm:3396,bounds:{west:0,east:5,north:5,south:0},wrapLongitude:false,sparse:true,heightAt:n=>heights.get(n)};
  const result=findRoute(terrain,0,4,{slopeLimit:40,riskWeight:0});
  assert.ok(result.path.length>5);
  assert.ok(result.path.includes(22));
  assert.ok(result.path.every(node=>heights.has(node)));
  const analysis=analyzeRoute(terrain,result.path);
  assert.ok(analysis.distanceKm>0);
  assert.equal(analysis.elevations.length,result.path.length);
});

test('route sections and transitions follow the footprint mask', () => {
  const terrain={width:4,height:1,bounds:{west:0,east:360,north:1,south:0},radiusKm:3396,cellKm:1};
  const mask={width:8,height:1,bytes:new Uint8Array([0b00110000])};
  const result=classifyRoute(terrain,[0,1,2,3],mask);
  assert.equal(result.points.length,4);
  assert.ok(result.segments.length>=2);
  assert.equal(result.transitions.length,result.segments.length-1);
});
