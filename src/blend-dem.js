import { findRoute, analyzeRoute } from './astar.js';
import { coordinateToGrid, gridToMarsCoordinate, terrainDistanceKm } from './terrain.js';

// USGS Astrogeology, HRSC/MOLA Blend DEM Global 200 m v2. The published
// BigTIFF has one uncompressed 16-bit strip per row, so HTTP byte ranges can
// read a route corridor without transferring its 11.4 GB source file.
export const BLEND_URL = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif';
export const BLEND = Object.freeze({width:106694,height:53347,rowOffset:854272,rowBytes:213388,totalBytes:11384463908,metresPerPost:200});
const RADIUS_KM = 3396.19;

export function maskContains(mask, lat, lon) {
  if (!mask || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const x = Math.min(mask.width - 1, Math.floor((((lon % 360) + 540) % 360) / 360 * mask.width));
  const y = Math.max(0, Math.min(mask.height - 1, Math.floor((90 - lat) / 180 * mask.height)));
  const bit = y * mask.width + x;
  return !!(mask.bytes[bit >> 3] & (128 >> (bit & 7)));
}

export async function loadCoverage(fetcher = fetch) {
  const [metadataResponse, maskResponse] = await Promise.all([
    fetcher(new URL('../data/hrsc-coverage.json', import.meta.url)),
    fetcher(new URL('../data/hrsc-coverage.bin', import.meta.url))
  ]);
  if (!metadataResponse.ok || !maskResponse.ok) throw new Error('HRSC coverage guide is unavailable');
  const meta = await metadataResponse.json();
  const bytes = new Uint8Array(await maskResponse.arrayBuffer());
  if (meta.width !== 5280 || meta.height !== 2616 || bytes.length !== meta.width * meta.height / 8) throw new Error('Invalid HRSC coverage guide');
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== meta.maskSha256) throw new Error('HRSC coverage checksum mismatch');
  }
  return {width:meta.width,height:meta.height,bytes,metadata:meta};
}

export function blendGrid(stride = 1) {
  if (!Number.isInteger(stride) || stride < 1 || stride > 64) throw new Error('Invalid blend sampling stride');
  const width = Math.ceil(BLEND.width / stride), height = Math.ceil(BLEND.height / stride);
  return {id:'hrsc-mola-blend',width,height,bounds:{west:0,east:360,north:90,south:-90},
    nativeGeo:{west:-180,north:90,pixelDegrees:0.003374120830641,width:BLEND.width,height:BLEND.height},radiusKm:RADIUS_KM,
    cellKm:RADIUS_KM * Math.PI / 180 * 180 / height,wrapLongitude:true,sparse:true,noData:-32768,stride};
}

function shortestDelta(a,b,width) {
  let delta=b-a;
  if (delta > width/2) delta-=width;
  if (delta < -width/2) delta+=width;
  return delta;
}

function addInterval(rows, y, min, max, width) {
  const add=(a,b)=>{const existing=rows.get(y)??[];existing.push([a,b]);rows.set(y,existing);};
  if(max-min>=width-1){add(0,width-1);return;}
  if(min<0){add(0,max);add(min+width,width-1);return;}
  if(max>=width){add(min,width-1);add(0,max-width);return;}
  add(min,max);
}

function mergeIntervals(intervals) {
  intervals.sort((a,b)=>a[0]-b[0]);
  const out=[];
  for(const [a,b] of intervals){const last=out[out.length-1];if(last&&a<=last[1]+1)last[1]=Math.max(last[1],b);else out.push([a,b]);}
  return out;
}

export function routeCorridor(points, grid, radiusKm = 5) {
  const rows=new Map();
  if(!points.length)return rows;
  const centres=points.map(p=>coordinateToGrid(p.lat,Math.min(360,Math.max(0,p.lon)),grid));
  const paint=(x,y)=>{
    const lat=90-(y+.5)*180/grid.height;
    const stepKm=RADIUS_KM*Math.PI/180*180/grid.height;
    const ry=Math.max(2,Math.ceil(radiusKm/stepKm));
    const rx=Math.max(2,Math.min(Math.ceil(radiusKm/Math.max(.08,stepKm*Math.cos(lat*Math.PI/180))),Math.floor(grid.width/8)));
    for(let dy=-ry;dy<=ry;dy++){
      const row=y+dy;if(row<0||row>=grid.height)continue;
      const half=Math.max(1,Math.floor(rx*Math.sqrt(Math.max(0,1-(dy/ry)**2))));
      addInterval(rows,row,Math.floor(x-half),Math.ceil(x+half),grid.width);
    }
  };
  paint(centres[0].x,centres[0].y);
  for(let i=1;i<centres.length;i++){
    const a=centres[i-1],b=centres[i],dx=shortestDelta(a.x,b.x,grid.width),dy=b.y-a.y;
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))/5));
    for(let j=1;j<=steps;j++)paint((a.x+dx*j/steps+grid.width)%grid.width,a.y+dy*j/steps);
  }
  for(const [y,intervals] of rows)rows.set(y,mergeIntervals(intervals));
  return rows;
}

export function chooseBlendGrid(points, maxSpacingM=Infinity, maxRows=1600, maxCells=1800000, alternativePoints=[]) {
  for(const stride of [1,2,4,8,16,32,64]){
    const grid=blendGrid(stride);
    const rows=routeCorridor(points,grid);
    for(const alternative of alternativePoints){
      const extra=routeCorridor(alternative,grid);
      for(const [y,intervals] of extra)rows.set(y,mergeIntervals([...(rows.get(y)??[]),...intervals]));
    }
    let cells=0;for(const intervals of rows.values())for(const [a,b] of intervals)cells+=b-a+1;
    const spacingM=RADIUS_KM*1000*Math.PI/180*180/grid.height;
    if(rows.size<=maxRows && cells<=maxCells){
      if(spacingM>maxSpacingM+1)throw new Error(`The requested ${Math.round(maxSpacingM)} m grid cannot be loaded for this route. Shorten the route or choose a coarser requirement.`);
      return {grid,rows,cells,spacingM};
    }
  }
  throw new Error('Route corridor is too large for browser processing. Choose closer points.');
}

async function checkedRange(start,end,fetcher,signal) {
  let lastError;
  for(let attempt=0;attempt<3;attempt++){
    if(signal?.aborted)throw new DOMException('Route cancelled','AbortError');
    try{
      const timeout=AbortSignal.timeout(20000);
      const requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
      const response=await fetcher(BLEND_URL,{headers:{Range:`bytes=${start}-${end}`},signal:requestSignal});
      if(response.status!==206){
        if(response.status===429||response.status>=500)throw new Error(`USGS elevation server temporarily returned ${response.status}`);
        throw new Error('USGS elevation server did not return a byte range');
      }
      const bytes=new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength!==end-start+1)throw new Error('Incomplete USGS elevation range');
      return bytes;
    }catch(error){
      if(error?.name==='AbortError')throw error;
      lastError=error;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)**2));
    }
  }
  throw new Error(`Could not load a USGS elevation range after retries: ${lastError?.message??'network error'}`);
}

export async function verifyBlendSource(fetcher=fetch,signal) {
  const bytes=await checkedRange(0,4095,fetcher,signal);
  const view=new DataView(bytes.buffer);
  if(view.getUint32(0,true)!==0x002b4949 || Number(view.getBigUint64(16,true))!==17)throw new Error('USGS elevation file format changed');
  const tags=new Map();
  for(let i=0;i<17;i++){const at=24+i*20;tags.set(view.getUint16(at,true),{count:Number(view.getBigUint64(at+4,true)),value:Number(view.getBigUint64(at+12,true))});}
  if(tags.get(256)?.value!==BLEND.width||tags.get(257)?.value!==BLEND.height||tags.get(259)?.value!==1||tags.get(273)?.count!==BLEND.height||tags.get(273)?.value!==427148||tags.get(278)?.value!==1||tags.get(339)?.value!==2)throw new Error('USGS elevation grid metadata changed');
  const offsets=await checkedRange(427148,427155,fetcher,signal),firstOffset=Number(new DataView(offsets.buffer).getBigUint64(0,true));
  if(firstOffset!==BLEND.rowOffset)throw new Error('USGS elevation strip location changed');
  return true;
}

function sourceColumn(x,grid) {
  const base=Math.floor((x+.5)*BLEND.width/grid.width);
  return (base+BLEND.width/2)%BLEND.width;
}
function sourceRow(y,grid) {return Math.min(BLEND.height-1,Math.floor((y+.5)*BLEND.height/grid.height));}

export async function loadBlendCorridor(selection,{fetcher=fetch,signal,onProgress=()=>{},concurrency=16,verifySource=verifyBlendSource}={}) {
  const {grid,rows}=selection;
  await verifySource(fetcher,signal);
  const jobs=[];
  for(const [y,intervals] of rows)for(const [first,last] of intervals){
    let start=first,previous=sourceColumn(first,grid);
    for(let x=first+1;x<=last+1;x++){
      const col=x<=last?sourceColumn(x,grid):-1;
      if(x<=last&&col>previous){previous=col;continue;}
      jobs.push({y,first:start,last:x-1,firstCol:sourceColumn(start,grid),lastCol:previous});
      start=x;previous=col;
    }
  }
  const ranges=jobs.map(job=>{
    const row=sourceRow(job.y,grid);
    const start=BLEND.rowOffset+row*BLEND.rowBytes+job.firstCol*2;
    return {...job,start,end:start+(job.lastCol-job.firstCol+1)*2-1};
  }).sort((a,b)=>a.start-b.start);
  const batches=[];
  for(const job of ranges){
    const batch=batches.at(-1);
    if(batch&&job.start-batch.end-1<=BLEND.rowBytes&&Math.max(batch.end,job.end)-batch.start+1<=1100000){
      batch.end=Math.max(batch.end,job.end);
      batch.jobs.push(job);
    }else batches.push({start:job.start,end:job.end,jobs:[job]});
  }
  const heights=new Map();let next=0,completed=0;
  await Promise.all(Array.from({length:Math.min(concurrency,batches.length)},async()=>{
    while(next<batches.length){
      if(signal?.aborted)throw new DOMException('Route cancelled','AbortError');
      const batch=batches[next++];
      const bytes=await checkedRange(batch.start,batch.end,fetcher,signal);
      const values=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(const job of batch.jobs){
        for(let x=job.first;x<=job.last;x++){
          const value=values.getInt16(job.start-batch.start+(sourceColumn(x,grid)-job.firstCol)*2,true);
          if(value!==-32768)heights.set(job.y*grid.width+x,value);
        }
        completed++;if(completed%25===0||completed===jobs.length)onProgress(completed,jobs.length);
      }
    }
  }));
  return {...grid,heightAt:node=>heights.get(node),loadedCells:heights.size};
}

export function classifyRoute(terrain,path,mask) {
  const points=path.map(node=>{
    const point=gridToMarsCoordinate(node%terrain.width,Math.floor(node/terrain.width),terrain);
    return {...point,source:maskContains(mask,point.lat,point.lon)?'hrsc':'mola'};
  });
  const segments=[];let current=null;
  for(let i=1;i<path.length;i++){
    const source=points[i].source;
    const lengthKm=terrainDistanceKm(terrain,path[i-1],path[i]);
    if(!current||current.source!==source){current={source,from:i-1,to:i,distanceKm:0};segments.push(current);}
    current.to=i;current.distanceKm+=lengthKm;
  }
  const transitions=segments.slice(1).map(segment=>({index:segment.from,point:points[segment.from],source:segment.source}));
  return {points,segments,transitions};
}

export async function calculateBlendRoute(coarsePoints,start,goal,options={},services={}) {
  const baseline=chooseBlendGrid(coarsePoints,options.maxGridSpacingM??Infinity);
  let selection=baseline;
  if(services.alternativePoints?.length){
    try{
      const wider=chooseBlendGrid(coarsePoints,options.maxGridSpacingM??Infinity,1600,1800000,services.alternativePoints);
      if(wider.spacingM<=baseline.spacingM)selection=wider;
    }catch{/* Keep the baseline resolution when alternate corridors exceed the transfer budget. */}
  }
  const terrain=await loadBlendCorridor(selection,services);
  const a=coordinateToGrid(start.lat,start.lon,terrain),b=coordinateToGrid(goal.lat,goal.lon,terrain);
  if(!a||!b)throw new Error('Choose points on the Mars map');
  const startNode=a.y*terrain.width+a.x,goalNode=b.y*terrain.width+b.x;
  const result=findRoute(terrain,startNode,goalNode,{...options,maxGridSpacingM:Infinity});
  if(!result.path.length)return {points:[],segments:[],transitions:[],analysis:analyzeRoute(terrain,[]),explored:result.explored,spacingM:selection.spacingM,loadedCells:terrain.loadedCells};
  const classified=classifyRoute(terrain,result.path,services.mask);
  return {...classified,terrain,analysis:analyzeRoute(terrain,result.path),explored:result.explored,spacingM:selection.spacingM,loadedCells:terrain.loadedCells,pathLength:result.path.length};
}
