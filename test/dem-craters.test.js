import test from 'node:test';
import assert from 'node:assert/strict';
import {detectDemCraterCandidates,detectOverviewCraterCandidates} from '../src/dem-craters.js';
import {NativeTileStore,findTiledPedestrianRoute} from '../src/tiled-route.js';

const width=160,height=160,cellM=1;
function fixture(shape){
  const elevation=new Float32Array(width*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)elevation[y*width+x]=shape(x,y);
  const terrain={id:'hirise',width,height,cellKm:cellM/1000,radiusKm:3396.19,
    bounds:{west:0,east:width/59300,north:height/59300,south:0},elevation,noData:NaN};
  const path=Array.from({length:121},(_,index)=>80*width+20+index);
  return {terrain,path};
}

test('terrain detector finds a broad crater on a sloping plane and rejects the plane alone',async()=>{
  const slope=(x,y)=>100+.02*x+.01*y;
  const flat=fixture(slope);
  const noCrater=await detectDemCraterCandidates(flat.terrain,null,flat.path);
  assert.equal(noCrater.hazards.length,0);
  const crater=fixture((x,y)=>{
    const distance=Math.hypot(x-80,y-80);
    return slope(x,y)-(distance<24?10*(1-(distance/24)**2):0);
  });
  const found=await detectDemCraterCandidates(crater.terrain,null,crater.path);
  assert.ok(found.hazards.some(item=>Math.abs(item.lon-80/59300)<.0002&&item.demDepthM>5));
  assert.equal(found.truncated,false);
});

test('terrain detector does not infer a depression across missing heights',async()=>{
  const {terrain,path}=fixture((x,y)=>{
    const distance=Math.hypot(x-80,y-80);
    return distance<24?90:100;
  });
  for(let y=40;y<120;y++)for(let x=40;x<120;x++)terrain.elevation[y*width+x]=NaN;
  const found=await detectDemCraterCandidates(terrain,null,path);
  assert.equal(found.hazards.length,0);
});

test('native-grid reroute excludes an identified depression circle',async()=>{
  const {terrain}=fixture(()=>100);
  const store=new NativeTileStore(terrain,(x,y,w,h)=>{
    const out=new Float32Array(w*h);
    for(let j=0;j<h;j++)for(let i=0;i<w;i++)out[j*w+i]=terrain.elevation[(y+j)*width+x+i];
    return out;
  },{tileSize:32,maxTiles:36});
  terrain.heightAt=node=>store.heightAt(node);
  const start=80*width+20,goal=80*width+140;
  const direct=await findTiledPedestrianRoute(terrain,store,start,goal,{radiusM:1,maxExplored:10000});
  const around=await findTiledPedestrianRoute(terrain,store,start,goal,
    {radiusM:1,maxExplored:20000,exclusionCircles:[{x:80,y:80,radiusM:25}]});
  assert.ok(around.path.length>0);
  assert.ok(around.cost>direct.cost);
  assert.ok(around.path.every(node=>Math.hypot(node%width-80,Math.floor(node/width)-80)>25));
});

test('large crater search reads a DTM overview and keeps its geographic position',async()=>{
  const nativeWidth=512,nativeHeight=512,overviewWidth=128,overviewHeight=128;
  const data=new Float32Array(overviewWidth*overviewHeight);
  for(let y=0;y<overviewHeight;y++)for(let x=0;x<overviewWidth;x++){
    const distance=Math.hypot((x-64)*4,(y-64)*4);
    data[y*overviewWidth+x]=100-(distance<96?20*(1-(distance/96)**2):0);
  }
  const base={getWidth:()=>nativeWidth,getHeight:()=>nativeHeight,getOrigin:()=>[0,512,0],
    getResolution:()=>[1,-1,0]};
  const overview={getWidth:()=>overviewWidth,getHeight:()=>overviewHeight,getGDALNoData:()=>NaN,
    readRasters:async({window:[left,top,right,bottom]})=>{
      const values=new Float32Array((right-left)*(bottom-top));
      for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)
        values[(y-top)*(right-left)+x-left]=data[y*overviewWidth+x];
      return [values];
    }};
  const tiff={getImageCount:async()=>3,getImage:async()=>overview};
  const metresPerDegree=3396190*Math.PI/180;
  const terrain={id:'hirise',width:nativeWidth,height:nativeHeight,radiusKm:3396.19,
    bounds:{west:0,east:512/metresPerDegree,north:512/metresPerDegree,south:0}};
  const path=Array.from({length:301},(_,index)=>256*nativeWidth+100+index);
  const found=await detectOverviewCraterCandidates(tiff,base,terrain,path,
    {decode:values=>({elevation:values,noData:NaN})});
  assert.ok(found.hazards.some(item=>Math.abs(item.lon-256/metresPerDegree)<.0002&&item.demDepthM>10));
  assert.equal(found.truncated,false);
});
