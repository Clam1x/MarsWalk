import {tileUrl} from './imagery.js';
import {toLocal} from './hazard-routing.js';

const RADIUS_M=3396190,RAD=Math.PI/180,SIZE=512;
const signed=lon=>lon>=180?lon-360:lon;
const tileDegrees=zoom=>180/2**zoom;
const key=(zoom,row,col)=>`${zoom}/${row}/${col}`;
const deltaLon=(a,b)=>((b-a+540)%360)-180;
function routeSamples(points,zoom,maxSamples=5000){
  const span=tileDegrees(zoom),out=[points[0]];
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dlon=deltaLon(a.lon,b.lon);
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(dlon),Math.abs(b.lat-a.lat))/span*4));
    if(out.length+steps>maxSamples)return {points:out,truncated:true};
    for(let j=1;j<=steps;j++){const f=j/steps;out.push({lat:a.lat+(b.lat-a.lat)*f,lon:(a.lon+dlon*f+360)%360});}
  }
  return {points:out,truncated:false};
}

export function tileForCoordinate(point,zoom){
  const span=tileDegrees(zoom),lon=signed(point.lon);
  return {zoom,row:Math.max(0,Math.min(2**zoom-1,Math.floor((90-point.lat)/span))),
    col:Math.max(0,Math.min(2**(zoom+1)-1,Math.floor((lon+180)/span)))};
}

export function selectSurveyTiles(points,maxTiles=32,maxZoom=12){
  for(let zoom=maxZoom;zoom>=9;zoom--){
    const sampled=routeSamples(points,zoom),tiles=new Map();
    for(const point of sampled.points){
      const tile=tileForCoordinate(point,zoom);tiles.set(key(tile.zoom,tile.row,tile.col),tile);
      if(tiles.size>maxTiles)break;
    }
    if(tiles.size<=maxTiles&&!sampled.truncated)return {zoom,tiles:[...tiles.values()],truncated:false,points:sampled.points};
  }
  const zoom=9,sampled=routeSamples(points,zoom),tiles=new Map();
  for(const point of sampled.points){
    const tile=tileForCoordinate(point,zoom);
    if(tiles.size<maxTiles)tiles.set(key(tile.zoom,tile.row,tile.col),tile);
  }
  return {zoom,tiles:[...tiles.values()],truncated:true,points:sampled.points};
}

function inTile(point,tile){
  const span=tileDegrees(tile.zoom),west=-180+tile.col*span,north=90-tile.row*span;
  return {x:(signed(point.lon)-west)/span*SIZE,y:(north-point.lat)/span*SIZE};
}
function distanceKm(a,b){
  const p=toLocal(a,b);return Math.hypot(p.x,p.y)/1000;
}
function routeSamplesByDistance(points,stepM,maxSamples=100000){
  const out=[points[0]];
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dlon=deltaLon(a.lon,b.lon);
    const steps=Math.max(1,Math.ceil(distanceKm(a,b)*1000/stepM));
    if(out.length+steps>maxSamples)return {points:out,truncated:true};
    for(let j=1;j<=steps;j++){
      const f=j/steps;
      out.push({lat:a.lat+(b.lat-a.lat)*f,lon:(a.lon+dlon*f+360)%360});
    }
  }
  return {points:out,truncated:false};
}
async function readTile(source,tile,fetcher){
  const response=await fetcher(tileUrl(source,tile.zoom,tile.row,tile.col),
    {signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Image tile unavailable');
  const bitmap=await createImageBitmap(await response.blob());
  try{
    const canvas=new OffscreenCanvas(SIZE,SIZE),context=canvas.getContext('2d',{willReadFrequently:true});
    context.drawImage(bitmap,0,0,SIZE,SIZE);
    return context.getImageData(0,0,SIZE,SIZE);
  }finally{bitmap.close?.();}
}
function pixelValid(image,point){
  const x=Math.floor(point.x),y=Math.floor(point.y);
  return x>=0&&y>=0&&x<SIZE&&y<SIZE&&image.data[(y*SIZE+x)*4+3]>=200;
}

export async function surveyRouteImages(points,{fetcher=fetch,maxTiles=32,maxZoom=12,strictCoverage=false,
  onProgress=()=>{},readTileImage=readTile}={}){
  if(points.length<2)return {inspectedKm:0,tiles:0,failed:0,zoom:null,truncated:false};
  const selection=selectSurveyTiles(points,maxTiles,maxZoom),tileMap=new Map();
  let failed=0,completed=0;
  // Keep remote image pressure bounded while inspecting the route's corridor.
  let next=0;
  await Promise.all(Array.from({length:Math.min(4,selection.tiles.length)},async()=>{
    while(next<selection.tiles.length){
      const tile=selection.tiles[next++],route=selection.points.map(point=>inTile(point,tile));
      let validSource=false;
      await Promise.all(['ctx','hirise'].map(async source=>{
        try{
          const image=await readTileImage(source,tile,fetcher);
          if(!route.some(point=>pixelValid(image,point)))return;
          validSource=true;
          tileMap.set(`${source}/${key(tile.zoom,tile.row,tile.col)}`,image);
        }catch{failed++;}
      }));
      if(!validSource)failed++;
      completed++;onProgress(completed,selection.tiles.length);
    }
  }));
  let inspectedKm=0,totalKm=0;
  const inspectedBySourceKm={ctx:0,hirise:0};
  for(let index=1;index<points.length;index++)totalKm+=distanceKm(points[index-1],points[index]);
  const imagePixelM=RADIUS_M*RAD*tileDegrees(selection.zoom)/SIZE;
  const sampled=strictCoverage?routeSamplesByDistance(points,imagePixelM/2):routeSamples(points,selection.zoom,10000);
  for(let index=1;index<sampled.points.length;index++){
    const a=sampled.points[index-1],b=sampled.points[index],length=distanceKm(a,b);
    const delta=deltaLon(a.lon,b.lon);
    const midpoint={lat:(a.lat+b.lat)/2,lon:((a.lon+delta/2)%360+360)%360};
    const tile=tileForCoordinate(midpoint,selection.zoom),position=inTile(midpoint,tile);
    let readable=false;
    for(const source of ['ctx','hirise']){
      const image=tileMap.get(`${source}/${key(tile.zoom,tile.row,tile.col)}`);
      if(image&&pixelValid(image,position)){inspectedBySourceKm[source]+=length;readable=true;}
    }
    if(readable)inspectedKm+=length;
  }
  return {inspectedKm,inspectedBySourceKm,totalKm,tiles:selection.tiles.length,failed,
    zoom:selection.zoom,imagePixelM,truncated:selection.truncated||sampled.truncated};
}
