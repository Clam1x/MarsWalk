import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeTileStore,findTiledPedestrianRoute} from '../src/tiled-route.js';

function fixture(width,height,heights,tileSize=8){
  const terrain={width,height,bounds:{west:0,east:width/59300,north:height/59300,south:0},radiusKm:3396.19,cellKm:.001,noData:NaN};
  const reads=[];
  const store=new NativeTileStore(terrain,(x,y,w,h)=>{
    reads.push([x,y,w,h]);const output=new Float32Array(w*h);
    for(let j=0;j<h;j++)for(let i=0;i<w;i++)output[j*w+i]=heights[(y+j)*width+x+i];
    return output;
  },{tileSize,maxTiles:80});
  terrain.heightAt=node=>store.heightAt(node);
  return {terrain,store,reads};
}

test('native search leaves the straight corridor for an opening',async()=>{
  const width=32,height=32,heights=new Float32Array(width*height);
  for(let y=7;y<height;y++)heights[y*width+16]=NaN;
  const {terrain,store}=fixture(width,height,heights);
  const start=20*width+5,goal=20*width+25;
  const result=await findTiledPedestrianRoute(terrain,store,start,goal,{radiusM:.1,maxExplored:20000});
  assert.ok(result.path.length>0);
  assert.ok(result.path.some(node=>Math.floor(node/width)<7));
});

test('a short route reads only nearby native tiles',async()=>{
  const width=128,height=128,heights=new Float32Array(width*height);
  const {terrain,store,reads}=fixture(width,height,heights);
  const result=await findTiledPedestrianRoute(terrain,store,10*width+10,10*width+18,{radiusM:.1,maxExplored:3000});
  assert.ok(result.path.length>0);
  assert.ok(reads.length<20,'short route should not download the full 128×128 model');
});

test('missing heights in walking clearance block a local crossing',async()=>{
  const width=8,height=8,heights=new Float32Array(width*height);
  for(let y=0;y<height;y++)heights[y*width+4]=NaN;
  const {terrain,store}=fixture(width,height,heights,4);
  const result=await findTiledPedestrianRoute(terrain,store,3*width+2,3*width+6,{radiusM:1,maxExplored:1000});
  assert.equal(result.path.length,0);
});

test('an apparent step blocks a crossing under the selected step limit',async()=>{
  const width=10,height=10,heights=new Float32Array(width*height);
  for(let y=0;y<height;y++)for(let x=5;x<width;x++)heights[y*width+x]=2;
  const {terrain,store}=fixture(width,height,heights,5);
  const blocked=await findTiledPedestrianRoute(terrain,store,5*width+2,5*width+7,
    {radiusM:.1,slopeLimit:89,crossSlopeLimit:89,stepLimitM:.6,maxExplored:1000});
  assert.equal(blocked.path.length,0);
});

test('cross-slope check diverts a route away from a side-height change',async()=>{
  const width=10,height=10,heights=new Float32Array(width*height);
  for(let x=0;x<width;x++)heights[4*width+x]=2;
  const {terrain,store}=fixture(width,height,heights,5);
  const route=await findTiledPedestrianRoute(terrain,store,3*width+2,3*width+7,
    {radiusM:.1,slopeLimit:89,crossSlopeLimit:10,stepLimitM:5,maxExplored:1000});
  assert.ok(route.path.length>0);
  assert.ok(route.path.some(node=>Math.floor(node/width)<3));
});
