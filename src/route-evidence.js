import {traversable} from './terrain.js';

// Evidence labels, not calibrated probabilities. Unknown evidence is never a pass.
export function localPathEvidence(terrain,path,{qualityAssets={},imageAgreement=false}={}){
  const reasons=[];
  if(!qualityAssets.provenance)reasons.push('processing provenance unavailable');
  else reasons.push('processing provenance not independently assessed');
  if(!qualityAssets.ortho)reasons.push('matched orthoimage unavailable');
  else reasons.push('matched orthoimage not compared with DTM');
  if(!qualityAssets.figureOfMerit)reasons.push('pixel provenance / interpolation unavailable');
  else reasons.push('pixel provenance / interpolation not interpreted');
  if(!imageAgreement)reasons.push('image–terrain agreement unmeasured');
  for(const node of path){
    const x=node%terrain.width,y=Math.floor(node/terrain.width);
    if(x<2||y<2||x>=terrain.width-2||y>=terrain.height-2){reasons.push('route approaches model edge');break;}
    let gap=false;
    for(let dy=-2;dy<=2&&!gap;dy++)for(let dx=-2;dx<=2;dx++)if(!traversable(terrain,(y+dy)*terrain.width+x+dx)){gap=true;break;}
    if(gap){reasons.push('route approaches missing DTM heights');break;}
  }
  return {status:reasons.length?'uncertain':'checked',reasons};
}

export function annotateRouteSegments(segments,localEvidenceById=new Map()){
  return segments.map(segment=>{
    const reasons=[];
    if(segment.source==='mola')reasons.push('MOLA source posts are coarser than the displayed grid');
    if(segment.source==='hrsc')reasons.push('HRSC coverage is an approximate footprint, not pixel provenance');
    if(segment.source==='unverified')reasons.push('elevation is unverified');
    if(segment.source==='ctx'||segment.source==='hirise'){
      const evidence=localEvidenceById.get(segment.modelId);
      reasons.push(...(evidence?.reasons??['local DTM quality not assessed']));
    }
    if(segment.from===segment.to)reasons.push('model transition has no measured connecting slope');
    return {...segment,evidence:{status:reasons.length?'uncertain':'checked',reasons}};
  });
}
