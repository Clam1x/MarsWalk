import {fromUrl} from 'geotiff';
import {analyzeRoute} from './astar.js';
import {coordinateToGrid,gridToMarsCoordinate} from './terrain.js';
import {localPathEvidence} from './route-evidence.js';
import {NativeTileStore,findTiledPedestrianRoute} from './tiled-route.js';
import {detectDemCraterCandidates,detectOverviewCraterCandidates} from './dem-craters.js';
import {edgeHitsHazard} from './hazard-routing.js';

const API='https://stac.astrogeology.usgs.gov/api/search';
const RADIUS_M=3396190;
const radians=Math.PI/180;
const sources=[
  {name:'hirise',collection:'mro_hirise_socet_dtms',asset:'dtm'},
  {name:'ctx',collection:'mro_ctx_controlled_usgs_dtms',asset:'dtm'}
];
const signed=longitude=>longitude>180?longitude-360:longitude;
const unsigned=longitude=>(longitude+360)%360;
const qualityAssets=(item,source)=>{
  const assets=item.assets??{};
  const ortho=source==='ctx'?assets.orthoimage?.href:
    Object.entries(assets).find(([name,asset])=>/^ortho_\d+$/.test(name)&&asset.href?.endsWith('.tif'))?.[1]?.href??
    Object.entries(assets).find(([name])=>name.endsWith('_ORTHO'))?.[1]?.href;
  return {ortho,provenance:assets.provenance?.href,figureOfMerit:assets.fom?.href??assets.FOM?.href,qaMetrics:assets.qa_metrics?.href,
    intersectionError:assets.intersection_error?.href};
};
async function catalogFeatures(url,{fetcher,signal,requireComplete=false,maxPages=8}={}){
  const items=[],seen=new Set();
  for(let page=0;page<maxPages;page++){
    const request=url.toString();
    if(seen.has(request))throw new Error('USGS local DTM catalogue pagination repeated a page');
    seen.add(request);
    const response=await fetcher(url,{signal});
    if(!response.ok)throw new Error('USGS local DTM catalogue is unavailable');
    const body=await response.json(),features=body.features??[];
    items.push(...features);
    const next=body.links?.find(link=>link.rel==='next');
    // Some USGS searches advertise a next page even when fewer than the requested
    // 100 items were returned. Read it before deciding that a strict search is incomplete.
    if(!next){
      if(requireComplete&&features.length>=Number(url.searchParams.get('limit')))
        throw new Error('USGS local DTM catalogue is incomplete for this area');
      return items;
    }
    const token=new URL(next.href).searchParams.get('next');
    if(!token)throw new Error('USGS local DTM catalogue pagination is incomplete');
    url=new URL(url);url.searchParams.set('next',token);
  }
  if(requireComplete)throw new Error('USGS local DTM catalogue is incomplete for this area');
  return items;
}
export async function modelOrthoAvailable(model,{fetcher=fetch}={}){
  const url=model.qualityAssets?.ortho;
  if(!url?.startsWith('https://astrogeo-ard.s3-us-west-2.amazonaws.com/'))return false;
  try{
    const response=await fetcher(url,{method:'HEAD',signal:AbortSignal.timeout(8000)});
    return response.ok;
  }catch{return false;}
}
export function decodeElevationSamples(values,rawNoData,metadata={}){
  const pick=(name,fallback)=>Number(metadata[name]??metadata[name.toLowerCase()]??fallback);
  const scale=pick('SCALE',1),offset=pick('OFFSET',0);
  if(!Number.isFinite(scale)||scale===0||!Number.isFinite(offset))throw new Error('Invalid DTM elevation scale or offset');
  const noData=rawNoData==null?NaN:Number(rawNoData);
  if(scale===1&&offset===0)return {elevation:values,noData};
  const elevation=new Float32Array(values.length);
  for(let i=0;i<values.length;i++)elevation[i]=values[i]===noData?NaN:values[i]*scale+offset;
  return {elevation,noData:NaN};
}

function inRing(point,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=ring[i],b=ring[j];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function inGeometry(point,geometry){
  if(!geometry)return false;
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.type==='MultiPolygon'?geometry.coordinates:[];
  return polygons.some(polygon=>inRing(point,polygon[0])&&!polygon.slice(1).some(hole=>inRing(point,hole)));
}

export async function discoverLocalModels(start,goal,{fetcher=fetch,signal,requireComplete=false}={}){
  const a=[signed(start.lon),start.lat],b=[signed(goal.lon),goal.lat];
  if(Math.abs(a[0]-b[0])>2||Math.abs(a[1]-b[1])>2)return [];
  const bbox=[Math.min(a[0],b[0])-.025,Math.min(a[1],b[1])-.025,Math.max(a[0],b[0])+.025,Math.max(a[1],b[1])+.025];
  const results=await Promise.allSettled(sources.map(async source=>{
    const url=new URL(API);url.searchParams.set('collections',source.collection);url.searchParams.set('bbox',bbox.join(','));url.searchParams.set('limit','100');
    const items=await catalogFeatures(url,{fetcher,signal,requireComplete});
    return items.filter(item=>inGeometry(a,item.geometry)&&inGeometry(b,item.geometry))
      .map(item=>({source:source.name,id:item.id,gsd:Number(item.properties?.gsd),
        url:item.assets?.[source.asset]?.href??(source.name==='ctx'?item.assets?.geoid_adjusted_dem?.href:null),projection:item.properties?.['proj:wkt2']??'',geometry:item.geometry,
        qualityAssets:qualityAssets(item,source.name)}));
  }));
  if(requireComplete&&results.some(item=>item.status==='rejected'))
    throw new Error('USGS local DTM catalogue is incomplete or unavailable for this area');
  const lists=results.filter(item=>item.status==='fulfilled').map(item=>item.value);
  if(!lists.length)throw new Error('USGS local DTM catalogue is unavailable');
  return lists.flat().filter(item=>Number.isFinite(item.gsd)&&item.gsd>0&&item.url?.startsWith('https://astrogeo-ard.s3-us-west-2.amazonaws.com/')&&(item.source==='hirise'||item.projection.includes('Equirectangular')))
    .sort((a,b)=>a.gsd-b.gsd);
}

export async function calculateLocalRoute(model,start,goal,options={}){
  const tiff=await fromUrl(model.url);
  const image=await tiff.getImage();
  const elevationMetadata={...(await image.getGDALMetadata()),...(await image.getGDALMetadata(0))};
  const keys=image.getGeoKeys();
  if(!String(keys.GTCitationGeoKey??'').includes('Equirectangular')||Number(keys.ProjStdParallel1GeoKey??0)!==0)return null;
  const [originX,originY]=image.getOrigin(),[resX,resY]=image.getResolution();
  if(!(resX>0&&resY<0))return null;
  const width=image.getWidth(),height=image.getHeight(),spacingM=Math.max(resX,Math.abs(resY));
  if(spacingM>(options.maxGridSpacingM??Infinity)+1)return null;
  const terrain={id:model.source,width,height,bounds:{west:originX/RADIUS_M/radians,east:(originX+width*resX)/RADIUS_M/radians,
    north:originY/RADIUS_M/radians,south:(originY+height*resY)/RADIUS_M/radians},radiusKm:RADIUS_M/1000,
    cellKm:Math.abs(resY)/1000,risk:null,noData:NaN,wrapLongitude:false};
  const a=coordinateToGrid(start.lat,signed(start.lon),terrain),b=coordinateToGrid(goal.lat,signed(goal.lon),terrain);
  if(!a||!b)return null;
  const rawNoData=image.getGDALNoData();
  const store=new NativeTileStore(terrain,async(x,y,w,h)=>{
    const raster=await image.readRasters({window:[x,y,x+w,y+h],samples:[0]});
    const decoded=decodeElevationSamples(raster[0],rawNoData,elevationMetadata);
    terrain.noData=decoded.noData;
    return decoded.elevation;
  },{tileSize:128,maxTiles:options.maxTiles??(options.verifiedOnly?128:192)});
  terrain.heightAt=node=>store.heightAt(node);
  const walking={slopeLimit:options.slopeLimit??12,crossSlopeLimit:options.crossSlopeLimit??options.slopeLimit??12,
    stepLimitM:options.stepLimitM??0.6,radiusM:options.vehicleRadiusM??1,
    maxExplored:options.maxExplored??(options.verifiedOnly?400000:300000),onProgress:options.onProgress};
  const startNode=a.y*width+a.x,goalNode=b.y*width+b.x;
  let result=await findTiledPedestrianRoute(terrain,store,startNode,goalNode,walking);
  if(!result.path.length)return null;
  const pointAt=node=>{const point=gridToMarsCoordinate(node%width,Math.floor(node/width),terrain);
    return {lat:point.lat,lon:unsigned(point.lon),source:model.source,modelId:model.id,spacingM};};
  const crosses=(path,hazard)=>path.some((node,index)=>index>0&&edgeHitsHazard(pointAt(path[index-1]),pointAt(node),hazard,
    {vehicleRadiusM:walking.radiusM}));
  const allHazards=[],avoided=[];
  let survey={hazards:[],testedCenters:0,truncated:false,available:false};
  for(let pass=0;pass<2;pass++){
    const overview=await detectOverviewCraterCandidates(tiff,image,terrain,result.path,
      {decode:(raw,noData)=>decodeElevationSamples(raw,noData,elevationMetadata)});
    const native=await detectDemCraterCandidates(terrain,store,result.path,
      {maxCenters:options.demMaxCenters??1800,maxExtraTiles:model.source==='hirise'?8:24,
        radiiM:model.source==='hirise'?[12,24]:[200,400,800]});
    const found={hazards:[...overview.hazards,...native.hazards],testedCenters:overview.testedCenters+native.testedCenters,
      truncated:overview.truncated||native.truncated,available:overview.available||native.available,
      error:overview.error??native.error};
    survey={...found,testedCenters:survey.testedCenters+found.testedCenters,
      truncated:survey.truncated||found.truncated,error:found.error??survey.error};
    for(const hazard of found.hazards)if(!allHazards.some(other=>
      Math.hypot((hazard.lon-other.lon)*Math.cos(hazard.lat*Math.PI/180),(hazard.lat-other.lat))*RADIUS_M*radians<
      Math.max(hazard.radiusM,other.radiusM)*.7))allHazards.push(hazard);
    const blocking=allHazards.filter(hazard=>crosses(result.path,hazard)&&
      hazard.demRadialSlopeDeg>=Math.min(walking.slopeLimit,10));
    if(!blocking.length||pass===1)break;
    const exclusions=blocking.map(hazard=>{
      const grid=coordinateToGrid(hazard.lat,signed(hazard.lon),terrain);
      return {x:grid.x,y:grid.y,radiusM:hazard.radiusM+hazard.contourErrorM};
    });
    try{
      const alternative=await findTiledPedestrianRoute(terrain,store,startNode,goalNode,
        {...walking,maxExplored:Math.min(walking.maxExplored,100000),exclusionCircles:exclusions});
      if(!alternative.path.length)break;
      avoided.push(...blocking.filter(hazard=>!crosses(alternative.path,hazard)));
      result=alternative;
    }catch(error){
      if(error?.name==='AbortError')throw error;
      survey={...survey,truncated:true,error:`Crater avoidance search: ${error.message}`};
      break;
    }
  }
  const unresolved=allHazards.filter(hazard=>crosses(result.path,hazard)&&
    hazard.demRadialSlopeDeg>=Math.min(walking.slopeLimit,10));
  const analysis=analyzeRoute(terrain,result.path),evidence=localPathEvidence(terrain,result.path,model);
  const points=result.path.map(pointAt);
  return {points,analysis,terrain,explored:result.explored,spacingM,loadedCells:result.tileCount*128*128,pathLength:result.path.length,
    segments:[{source:model.source,modelId:model.id,spacingM,from:0,to:points.length-1,distanceKm:analysis.distanceKm}],transitions:[],
    modelId:model.id,modelUrl:model.url,footprint:model.geometry,qualityAssets:model.qualityAssets,evidence,
    alternativesCompared:1,maxCrossSlope:result.maxCrossSlope,nativeTiles:store.readCount,
    demHazards:allHazards,demSurvey:{testedCenters:survey.testedCenters,truncated:survey.truncated,
      available:survey.available,error:survey.error},demAvoided:avoided,demUnresolved:unresolved};
}

export async function bestLocalRoute(start,goal,options={},services={}){
  const models=await discoverLocalModels(start,goal,services);
  let limitError=null;
  for(const model of models.slice(0,6)){
    if(model.gsd>(options.maxGridSpacingM??Infinity)+1)continue;
    try{const route=await calculateLocalRoute(model,start,goal,options);if(route)return route;}catch(error){
      if(error?.name==='AbortError')throw error;
      if(/budget|supported native-grid/i.test(error.message))limitError=error;
    }
  }
  if(limitError)throw limitError;
  return null;
}

// Find published stereo products intersecting the route itself, including when
// neither endpoint lies in a local DTM. The catalogue search returns metadata;
// numeric heights are still read only from products selected below.
export async function discoverRouteModels(points,{fetcher=fetch,signal}={}){
  if(points.length<2)return [];
  const sampled=points.filter((_,index)=>index===0||index===points.length-1||index%Math.max(1,Math.ceil(points.length/120))===0);
  const lines=[[]];
  for(const point of sampled){
    const coordinate=[signed(point.lon),point.lat],line=lines.at(-1);
    if(line.length&&Math.abs(coordinate[0]-line.at(-1)[0])>180){
      if(line.length<2)line.push(line[0]);
      lines.push([]);
    }
    lines.at(-1).push(coordinate);
  }
  const valid=lines.filter(line=>line.length>=2);
  if(!valid.length)return [];
  const intersects=valid.length===1?{type:'LineString',coordinates:valid[0]}:{type:'MultiLineString',coordinates:valid};
  const url=new URL(API);
  url.searchParams.set('collections',sources.map(source=>source.collection).join(','));
  url.searchParams.set('intersects',JSON.stringify(intersects));
  url.searchParams.set('limit','500');
  const response=await fetcher(url,{signal});
  if(!response.ok)throw new Error('USGS local DTM catalogue is unavailable');
  const body=await response.json();
  const byCollection=new Map(sources.map(source=>[source.collection,source]));
  return (body.features??[]).map(item=>{
    const source=byCollection.get(item.collection);
    return source?{source:source.name,id:item.id,gsd:Number(item.properties?.gsd),
      url:item.assets?.[source.asset]?.href??(source.name==='ctx'?item.assets?.geoid_adjusted_dem?.href:null),projection:item.properties?.['proj:wkt2']??'',geometry:item.geometry,
      qualityAssets:qualityAssets(item,source.name)}:null;
  }).filter(item=>item&&Number.isFinite(item.gsd)&&item.gsd>0&&item.url?.startsWith('https://astrogeo-ard.s3-us-west-2.amazonaws.com/')&&
    (item.source==='hirise'||item.projection.includes('Equirectangular'))).sort((a,b)=>a.gsd-b.gsd);
}

export async function localRoutePatches(points,options={},services={}){
  const models=await discoverRouteModels(points,services),claimed=new Uint8Array(points.length),patches=[];
  const routeForModel=services.routeForModel??calculateLocalRoute;
  let noConnectedRange=0,budgetLimitedRange=0;
  for(const model of models){
    if(patches.length>=24)break;
    if(model.gsd>(options.maxGridSpacingM??Infinity)+1)continue;
    let attempts=0;
    const tryRange=async(first,last,depth=0)=>{
      if(last-first<2||attempts>=12||patches.length>=24)return;
      attempts++;
      try{
        const route=await routeForModel(model,points[first],points[last],
          {...options,maxExplored:100000,maxTiles:64,demMaxCenters:400});
        if(route&&route.points.length>=2){patches.push({from:first,to:last,route,model});claimed.fill(1,first,last+1);return;}
        noConnectedRange++;
      }catch(error){
        if(error?.name==='AbortError')throw error;
        if(!/budget|tile limit/i.test(error.message)){noConnectedRange++;return;}
        budgetLimitedRange++;
      }
      if(depth<3){
        const middle=Math.floor((first+last)/2);
        await tryRange(first,middle,depth+1);
        await tryRange(claimed[middle]?middle+1:middle,last,depth+1);
      }
    };
    let first=-1;
    for(let index=0;index<=points.length;index++){
      const inside=index<points.length&&!claimed[index]&&inGeometry([signed(points[index].lon),points[index].lat],model.geometry);
      if(inside&&first<0)first=index;
      if(!inside&&first>=0){
        const last=index-1;
        if(last-first>=2)await tryRange(first,last);
        first=-1;
      }
    }
  }
  patches.searchNote=(noConnectedRange||budgetLimitedRange)?
    `${models.length} stereo model footprint${models.length===1?'':'s'} intersected the candidate route, but some native-grid sections had no connected path under the selected walking limits${budgetLimitedRange?' or reached the search budget':''}. The remaining coarse sections are not checked at walking scale.`:null;
  return patches.sort((a,b)=>a.from-b.from);
}
