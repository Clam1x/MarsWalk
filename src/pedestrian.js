import {cellMetrics} from './accuracy.js';
import {terrainSlopeDegrees,traversable} from './terrain.js';

// Check a corridor around every route node using only measured DEM cells.
// This cannot reveal features smaller than the DTM's true resolving power.
export function pedestrianCellFilter(terrain,{radiusM=1,slopeLimit=12}={}) {
  const cache=new Map();
  return node=>{
    if(cache.has(node))return cache.get(node);
    if(!traversable(terrain,node)){cache.set(node,false);return false;}
    const {eastWestM,northSouthM}=cellMetrics(terrain,node);
    const extra=Math.hypot(eastWestM,northSouthM)/2;
    const nx=Math.ceil((radiusM+extra)/eastWestM),ny=Math.ceil((radiusM+extra)/northSouthM);
    if(nx>4||ny>4){cache.set(node,false);return false;}
    const x=node%terrain.width,y=Math.floor(node/terrain.width);
    let pass=true;
    for(let dy=-ny;dy<=ny&&pass;dy++)for(let dx=-nx;dx<=nx;dx++){
      if(Math.hypot(dx*eastWestM,dy*northSouthM)>radiusM+extra)continue;
      const sx=x+dx,sy=y+dy;
      if(sx<0||sy<0||sx>=terrain.width||sy>=terrain.height){pass=false;break;}
      const other=sy*terrain.width+sx;
      if(!traversable(terrain,other)||terrainSlopeDegrees(terrain,node,other)>slopeLimit){pass=false;break;}
    }
    cache.set(node,pass);
    return pass;
  };
}
