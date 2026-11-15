import {cellMetrics} from './accuracy.js';
import {gridToMarsCoordinate} from './terrain.js';

const ANGLES=8;
const signed=lon=>(lon+360)%360;
const median=values=>{
  const sorted=[...values].sort((a,b)=>a-b);
  return (sorted[(sorted.length-1)>>1]+sorted[sorted.length>>1])/2;
};

// The DTM is evidence for a depression, not proof of a crater or a measured rim.
// Opposite radial samples cancel a planar hillside; the outer ring helps reject
// isolated raised rings. All sampled posts must be present.
function depressionAt(terrain,cx,cy,radiusM,eastWestM,northSouthM,minDepthM){
  const width=terrain.width,height=terrain.height;
  const heightAt=(x,y)=>{
    const px=Math.round(x),py=Math.round(y);
    if(px<0||py<0||px>=width||py>=height)return NaN;
    const value=terrain.heightAt?terrain.heightAt(py*width+px):terrain.elevation[py*width+px];
    return Number.isFinite(value)&&value!==terrain.noData?value:NaN;
  };
  const radial=(angle,fraction)=>{
    const x=cx+Math.cos(angle)*radiusM*fraction/eastWestM;
    const y=cy+Math.sin(angle)*radiusM*fraction/northSouthM;
    const values=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const value=heightAt(x+dx,y+dy);
      if(!Number.isFinite(value))return NaN;
      values.push(value);
    }
    return median(values);
  };
  const depths=[],outsideDepths=[];
  for(let i=0;i<ANGLES;i++){
    const a=i*Math.PI/ANGLES,b=a+Math.PI;
    const innerA=radial(a,.2),innerB=radial(b,.2);
    const rimA=radial(a,1),rimB=radial(b,1);
    const outerA=radial(a,1.3),outerB=radial(b,1.3);
    if([innerA,innerB,rimA,rimB,outerA,outerB].some(value=>!Number.isFinite(value)))return null;
    const inner=(innerA+innerB)/2;
    depths.push((rimA+rimB)/2-inner);
    outsideDepths.push((outerA+outerB)/2-inner);
  }
  const depth=median(depths),outsideDepth=median(outsideDepths);
  const coherent=depths.filter((value,index)=>value>=minDepthM*.65&&outsideDepths[index]>=minDepthM*.25).length;
  if(depth<minDepthM||outsideDepth<minDepthM*.35||coherent<6)return null;
  return {depthM:depth,coherence:coherent/ANGLES,
    radialSlopeDeg:Math.atan2(depth,radiusM*.8)*180/Math.PI};
}

function radialSamplePoints(cx,cy,radiusM,eastWestM,northSouthM){
  const points=[];
  for(let angle=0;angle<ANGLES*2;angle++)for(const fraction of [.2,1,1.3]){
    const radians=angle*Math.PI/ANGLES;
    const x=Math.round(cx+Math.cos(radians)*radiusM*fraction/eastWestM);
    const y=Math.round(cy+Math.sin(radians)*radiusM*fraction/northSouthM);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)points.push({x:x+dx,y:y+dy});
  }
  return points;
}

export async function detectDemCraterCandidates(terrain,store,path,
  {maxCenters=1800,maxHazards=32,maxExtraTiles=24,radiiM:chosenRadii}={}){
  if(!path?.length||!['hirise','ctx'].includes(terrain.id))
    return {hazards:[],testedCenters:0,truncated:false,available:false};
  const sample=cellMetrics(terrain,path[0]);
  const spacingM=Math.max(sample.eastWestM,sample.northSouthM);
  // A diameter of at least roughly 20 posts avoids presenting individual
  // 1–2 m DTM posts as resolved walking-scale crater contours.
  const radiiM=chosenRadii??(terrain.id==='hirise'?[12,24,48,96,192]:[200,400,800]);
  const hazards=[],seen=new Set();
  let testedCenters=0,truncated=false;
  const initialTiles=store?.readCount??0;
  outer:for(const radiusM of radiiM){
    const naturalStep=Math.max(1,Math.round(radiusM/Math.max(spacingM,1)/3));
    const step=Math.max(naturalStep,Math.ceil(path.length*5/Math.max(1,maxCenters-testedCenters)));
    if(step>naturalStep)truncated=true;
    for(let p=0;p<path.length;p+=step){
      const node=path[p],before=path[Math.max(0,p-step)],after=path[Math.min(path.length-1,p+step)];
      const px=node%terrain.width,py=Math.floor(node/terrain.width);
      const dx=after%terrain.width-before%terrain.width;
      const dy=Math.floor(after/terrain.width)-Math.floor(before/terrain.width);
      const length=Math.hypot(dx,dy)||1,nx=-dy/length,ny=dx/length;
      for(const offset of [-1,-.5,0,.5,1]){
        if(testedCenters>=maxCenters){truncated=true;break outer;}
        const cx=Math.round(px+nx*offset*radiusM/sample.eastWestM);
        const cy=Math.round(py+ny*offset*radiusM/sample.northSouthM);
        const key=`${radiusM}/${cx}/${cy}`;
        if(seen.has(key))continue;
        seen.add(key);testedCenters++;
        if(store&&store.readCount-initialTiles>=maxExtraTiles){truncated=true;break outer;}
        const xSpan=Math.ceil(radiusM*1.3/sample.eastWestM)+2;
        const ySpan=Math.ceil(radiusM*1.3/sample.northSouthM)+2;
        if(cx-xSpan<0||cy-ySpan<0||cx+xSpan>=terrain.width||cy+ySpan>=terrain.height)continue;
        try{await store?.ensurePoints(radialSamplePoints(cx,cy,radiusM,sample.eastWestM,sample.northSouthM));}
        catch(error){
          if(error?.name==='AbortError')throw error;
          return {hazards,testedCenters,truncated:true,available:true,error:error.message};
        }
        const minDepthM=terrain.id==='hirise'?Math.max(3,radiusM*.06):Math.max(15,radiusM*.06);
        const shape=depressionAt(terrain,cx,cy,radiusM,sample.eastWestM,sample.northSouthM,minDepthM);
        if(!shape)continue;
        const point=gridToMarsCoordinate(cx,cy,terrain);
        hazards.push({lat:point.lat,lon:signed(point.lon),radiusM,contourErrorM:spacingM*2+radiusM*.15,
          source:terrain.id,method:'terrain',modelCheck:'dem_depression',demSource:terrain.id,
          demSpacingM:spacingM,demDepthM:Math.round(shape.depthM*10)/10,
          demRadialSlopeDeg:Math.round(shape.radialSlopeDeg*10)/10,
          coherence:shape.coherence,score:Math.min(1,.8+.2*shape.coherence)});
      }
    }
  }
  hazards.sort((a,b)=>b.demDepthM-a.demDepthM);
  const distinct=[];
  for(const hazard of hazards){
    if(distinct.some(other=>{
      const dLon=((hazard.lon-other.lon+540)%360)-180;
      const dx=dLon*Math.PI/180*3396190*Math.cos((hazard.lat+other.lat)/2*Math.PI/180);
      const dy=(hazard.lat-other.lat)*Math.PI/180*3396190;
      return Math.hypot(dx,dy)<Math.max(hazard.radiusM,other.radiusM)*.7;
    }))continue;
    distinct.push(hazard);
    if(distinct.length>=maxHazards){truncated=true;break;}
  }
  return {hazards:distinct,testedCenters,truncated,available:true};
}

export async function detectOverviewCraterCandidates(tiff,baseImage,terrain,path,{decode,maxChunks=8}={}){
  if(terrain.id!=='hirise'||!path.length)return {hazards:[],testedCenters:0,truncated:false,available:false};
  const imageCount=await tiff.getImageCount();
  if(imageCount<3)return {hazards:[],testedCenters:0,truncated:true,available:false,
    error:'The HiRISE DTM has no suitable overview for large depressions.'};
  const overview=await tiff.getImage(2);
  const scaleX=baseImage.getWidth()/overview.getWidth(),scaleY=baseImage.getHeight()/overview.getHeight();
  const [originX,originY]=baseImage.getOrigin(),[resolutionX,resolutionY]=baseImage.getResolution();
  const metresPerDegree=(terrain.radiusKm*1000)*Math.PI/180;
  const hazards=[];
  let testedCenters=0,truncated=path.length>maxChunks*500;
  for(let first=0,chunkIndex=0;first<path.length&&chunkIndex<maxChunks;first+=500,chunkIndex++){
    const chunk=path.slice(first,Math.min(path.length,first+501));
    const xs=chunk.map(node=>node%terrain.width),ys=chunk.map(node=>Math.floor(node/terrain.width));
    const marginX=Math.ceil(255/(resolutionX*scaleX))+2,marginY=Math.ceil(255/(Math.abs(resolutionY)*scaleY))+2;
    const left=Math.max(0,Math.floor(Math.min(...xs)/scaleX)-marginX);
    const right=Math.min(overview.getWidth(),Math.ceil(Math.max(...xs)/scaleX)+marginX+1);
    const top=Math.max(0,Math.floor(Math.min(...ys)/scaleY)-marginY);
    const bottom=Math.min(overview.getHeight(),Math.ceil(Math.max(...ys)/scaleY)+marginY+1);
    const width=right-left,height=bottom-top;
    if(width<20||height<20){truncated=true;continue;}
    let decoded;
    try{
      const raw=(await overview.readRasters({window:[left,top,right,bottom],samples:[0]}))[0];
      decoded=decode(raw,overview.getGDALNoData());
    }catch(error){
      if(error?.name==='AbortError')throw error;
      return {hazards,testedCenters,truncated:true,available:true,error:error.message};
    }
    const local={id:'hirise',width,height,elevation:decoded.elevation,noData:decoded.noData,radiusKm:terrain.radiusKm,
      cellKm:Math.abs(resolutionY*scaleY)/1000,
      bounds:{west:(originX+left*scaleX*resolutionX)/metresPerDegree,
        east:(originX+right*scaleX*resolutionX)/metresPerDegree,
        north:(originY+top*scaleY*resolutionY)/metresPerDegree,
        south:(originY+bottom*scaleY*resolutionY)/metresPerDegree}};
    const localPath=[];
    for(const node of chunk){
      const x=Math.floor((node%terrain.width)/scaleX)-left;
      const y=Math.floor(Math.floor(node/terrain.width)/scaleY)-top;
      const value=y*width+x;
      if(value!==localPath.at(-1))localPath.push(value);
    }
    const found=await detectDemCraterCandidates(local,null,localPath,
      {radiiM:[48,96,192],maxCenters:700,maxHazards:32});
    hazards.push(...found.hazards);
    testedCenters+=found.testedCenters;
    truncated ||= found.truncated;
  }
  const distinct=[];
  for(const hazard of hazards.sort((a,b)=>b.demDepthM-a.demDepthM)){
    if(distinct.some(other=>{
      const dLon=((hazard.lon-other.lon+540)%360)-180;
      return Math.hypot(dLon*Math.cos(hazard.lat*Math.PI/180),hazard.lat-other.lat)*metresPerDegree<
        Math.max(hazard.radiusM,other.radiusM)*.7;
    }))continue;
    distinct.push(hazard);
  }
  return {hazards:distinct,testedCenters,truncated,available:true};
}
