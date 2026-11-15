import { decodeTerrain } from './nasa-adapter.js';
import { decodeGlobalRouting, calculateGlobalRoute } from './global-route.js';
import { calculateBlendRoute, loadCoverage } from './blend-dem.js';
import { bestLocalRoute, calculateLocalRoute, discoverLocalModels, localRoutePatches, modelOrthoAvailable } from './local-dtm.js';
import { stitchLocalPatches } from './route-stitch.js';
import {surveyRouteImages} from './image-coverage.js';
import {rebuildRouteQuality} from './hazard-routing.js';
import {assessVerifiedRoute} from './verified-route.js';
import {annotateRouteSegments} from './route-evidence.js';

async function fetchVerified(id) {
  const metaResponse = await fetch(new URL(`../data/${id}.json`, import.meta.url));
  if (!metaResponse.ok) throw new Error('Could not load global elevation metadata');
  const metadata = await metaResponse.json();
  let buffer;
  if (metadata.parts?.length) {
    const total = metadata.parts.reduce((sum, part) => sum + part.bytes, 0);
    buffer = new ArrayBuffer(total);
    const output = new Uint8Array(buffer);
    let offset = 0;
    for (const part of metadata.parts) {
      const response = await fetch(new URL(`../data/${part.file}`, import.meta.url));
      if (!response.ok) throw new Error('Could not load a global elevation part');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== part.bytes) throw new Error('Global elevation part has incorrect length');
      if (globalThis.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
        if (hash !== part.sha256) throw new Error('Global elevation part checksum mismatch');
      }
      output.set(bytes, offset);
      offset += bytes.length;
    }
  } else {
    const dataResponse = await fetch(new URL(`../data/${id}.bin`, import.meta.url));
    if (!dataResponse.ok) throw new Error('Could not load global elevation data');
    buffer = await dataResponse.arrayBuffer();
  }
  if (globalThis.crypto?.subtle && metadata.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== metadata.sha256) throw new Error('Global elevation checksum mismatch');
  }
  return { metadata, buffer };
}

let sourcePromise;
function sources() {
  sourcePromise ??= Promise.all([fetchVerified('mars-global'), fetchVerified('mars-routing')]).then(([overview, detail]) => {
    const coarse = decodeTerrain(overview.metadata, overview.buffer);
    coarse.wrapLongitude = true;
    coarse.risk = null;
    return { coarse, fine: decodeGlobalRouting(detail.metadata, detail.buffer) };
  });
  return sourcePromise;
}

let coveragePromise;
function coverage() { return coveragePromise ??= loadCoverage(); }

async function inspectRoute(route,id,surveyOptions={}){
  const terrainHazards=route.demHazards??[];
  const result={...route,...rebuildRouteQuality(route.points,route.analysis.elevations),
    pathLength:route.points.length,avoided:route.demAvoided??[],unresolved:route.demUnresolved??[]};
  if(!surveyOptions.strictCoverage)return {result,hazards:terrainHazards,
    survey:{unavailable:'Matched-image coverage was not assessed',totalKm:route.analysis.distanceKm}};
  self.postMessage({id,stage:'imagery'});
  try{
    const survey=await surveyRouteImages(route.points,{...surveyOptions,onProgress:(done,total)=>
      self.postMessage({id,stage:'imagery',progress:Math.round(done/total*100)})});
    return {result,hazards:terrainHazards,survey:{inspectedKm:survey.inspectedKm,inspectedBySourceKm:survey.inspectedBySourceKm,totalKm:survey.totalKm,
      imagePixelM:survey.imagePixelM,tiles:survey.tiles,failed:survey.failed,
      truncated:survey.truncated,zoom:survey.zoom}};
  }catch(error){
    return {result,hazards:terrainHazards,survey:{inspectedKm:0,totalKm:route.analysis.distanceKm,
      unavailable:error.message}};
  }
}

function postLocalResult(id,local,{result,hazards,survey},verifiedOnly=false){
  self.postMessage({id,result:{points:result.points,explored:local.explored,pathLength:result.pathLength},analysis:result.analysis,
    quality:{source:local.modelId,sourceUrl:local.modelUrl,spacingM:local.spacingM,loadedCells:local.loadedCells,nativeTiles:local.nativeTiles,maxCrossSlope:local.maxCrossSlope,
      segments:annotateRouteSegments(result.segments,new Map([[local.modelId,local.evidence]])),transitions:result.transitions,footprint:local.footprint,qualityAssets:local.qualityAssets,
      alternativesCompared:local.alternativesCompared,
      verifiedOnly,terrainHazards:hazards,demSurvey:local.demSurvey,imageSurvey:survey,avoidedHazards:result.avoided??[],
      unresolvedHazards:result.unresolved??[],unverifiedKm:result.unverifiedKm??0,
      unverifiedJoinKm:result.unverifiedJoinKm??0}});
}

self.onmessage = async ({data}) => {
  try {
    if(!Number.isFinite(data.options.vehicleRadiusM)||data.options.vehicleRadiusM<0||data.options.vehicleRadiusM>50)
      throw new Error('Invalid walking clearance radius.');
    self.postMessage({id:data.id,stage:'local'});
    if(data.options.verifiedOnly){
      const models=await discoverLocalModels(data.start,data.goal,{requireComplete:true});
      const reasons=[];
      for(const model of models.filter(model=>model.source==='hirise'&&model.gsd<=2)){
        if(!model.qualityAssets?.figureOfMerit){
          reasons.push('Pixel provenance / interpolation data are unavailable for this HiRISE DTM.');continue;
        }
        if(!await modelOrthoAvailable(model)){
          reasons.push('The local DTM has no reachable matching orthoimage.');continue;
        }
        let candidate;
        try{candidate=await calculateLocalRoute(model,data.start,data.goal,
          {...data.options,maxGridSpacingM:Math.min(2,data.options.maxGridSpacingM),verifiedOnly:true,
            onProgress:(explored,tiles)=>self.postMessage({id:data.id,stage:'native',explored,tiles})});}
        catch(error){if(error?.name==='AbortError')throw error;reasons.push('A local DTM could not be read.');continue;}
        if(!candidate){reasons.push('No native-resolution walking corridor fits within this local DTM.');continue;}
        if(candidate.evidence.status!=='checked'){
          reasons.push(`DTM quality is uncertain: ${candidate.evidence.reasons.join('; ')}.`);continue;
        }
        const checked=await inspectRoute(candidate,data.id,{maxTiles:64,maxZoom:15,strictCoverage:true});
        const assessment=assessVerifiedRoute(checked.result,checked.survey);
        if(assessment.ok){postLocalResult(data.id,candidate,checked,true);return;}
        reasons.push(...assessment.reasons);
      }
      self.postMessage({id:data.id,noVerifiedRoute:true,reason:reasons[0]??
        'No continuous HiRISE stereo DTM at 2 m or finer covers both points. Try a shorter route inside a HiRISE DTM footprint.'});
      return;
    }
    let local=null,localSearchNote=null;
    try{local=await bestLocalRoute(data.start,data.goal,{...data.options,
      onProgress:(explored,tiles)=>self.postMessage({id:data.id,stage:'native',explored,tiles})});}catch(error){if(data.options.maxGridSpacingM<200)throw error;localSearchNote=error.message;}
    if(local){
      postLocalResult(data.id,local,await inspectRoute(local,data.id));
      return;
    }
    if(data.options.maxGridSpacingM<200)throw new Error('No connected CTX or HiRISE DTM covers both route points at the requested grid detail.');
    self.postMessage({id:data.id,stage:'loading'});
    const {coarse,fine} = await sources();
    self.postMessage({id:data.id,stage:'routing'});
    const coarseResult = calculateGlobalRoute(coarse,fine,data.start,data.goal,{...data.options,slopeLimit:Math.max(40,data.options.slopeLimit),maxGridSpacingM:Infinity});
    if(!coarseResult.points.length){
      self.postMessage({id:data.id,result:{points:[],explored:coarseResult.explored,pathLength:0},analysis:coarseResult.analysis});
      return;
    }
    self.postMessage({id:data.id,stage:'coverage'});
    const mask=await coverage();
    self.postMessage({id:data.id,stage:'detail'});
    const detail=await calculateBlendRoute(coarseResult.points,data.start,data.goal,data.options,{
      mask,alternativePoints:coarseResult.alternativePoints,onProgress:(done,total)=>self.postMessage({id:data.id,stage:'detail',progress:Math.round(done/total*100)})
    });
    self.postMessage({id:data.id,stage:'patching'});
    let patches=[],localPatchNote=null;
    try{patches=await localRoutePatches(detail.points,data.options);localPatchNote=patches.searchNote;}
    catch(error){if(error?.name==='AbortError')throw error;localPatchNote=`Stereo model search could not finish: ${error.message}`;}
    const refined=stitchLocalPatches(detail,patches);
    const {result:checked,hazards,survey}=await inspectRoute(refined,data.id);
    self.postMessage({
      id:data.id,
      result:{points:checked.points,explored:coarseResult.explored+refined.explored,pathLength:checked.pathLength??0},
      analysis:checked.analysis,
      quality:{source:'USGS HRSC/MOLA Blend v2',spacingM:refined.spacingM,loadedCells:refined.loadedCells,
        localSearchNote:[localSearchNote,localPatchNote].filter(Boolean).join(' '),
        segments:annotateRouteSegments(checked.segments,new Map(patches.map(patch=>[patch.model.id,patch.route.evidence]))),transitions:checked.transitions,localModels:refined.localModels,
        footprintNote:mask.metadata.note,terrainHazards:hazards,demSurvey:refined.demSurvey,imageSurvey:survey,
        avoidedHazards:checked.avoided??[],unresolvedHazards:checked.unresolved??[],unverifiedKm:checked.unverifiedKm??0,
        unverifiedJoinKm:checked.unverifiedJoinKm??0}
    });
  } catch(error) {
    self.postMessage({id:data.id,error:error.message});
  }
};
