import { findRoute, analyzeRoute } from './astar.js';
import { coordinateToGrid, gridToMarsCoordinate } from './terrain.js';
import { routeInputQuality, terrainMeetsDetail } from './accuracy.js';

export function decodeGlobalRouting(metadata, buffer) {
  if (metadata.id !== 'mars-routing' || metadata.encoding !== 'int16-le' || metadata.width !== 5760 || metadata.height !== 2880 || buffer.byteLength !== 33177600) throw new Error('Invalid global routing grid');
  if (new Uint16Array(new Uint8Array([1, 0]).buffer)[0] !== 1) throw new Error('Unsupported byte order');
  return {
    ...metadata,
    elevation: new Int16Array(buffer),
    cellKm: metadata.radiusKm * Math.PI / 180 / metadata.pixelsPerDegree,
    wrapLongitude: true,
    risk: null
  };
}

function gridNode(coordinate, terrain) {
  const point = coordinateToGrid(coordinate.lat, coordinate.lon, terrain);
  return point ? point.y * terrain.width + point.x : null;
}

function corridor(coarsePath, coarseWidth, coarseHeight, radius) {
  const cells = new Set();
  for (const node of coarsePath) {
    const x = node % coarseWidth, y = Math.floor(node / coarseWidth);
    for (let dy = -radius; dy <= radius; dy++) {
      const row = y + dy;
      if (row < 0 || row >= coarseHeight) continue;
      for (let dx = -radius; dx <= radius; dx++) cells.add(row * coarseWidth + (x + dx + coarseWidth) % coarseWidth);
    }
  }
  return cells;
}

export function calculateGlobalRoute(coarse, fine, start, goal, options = {}) {
  if (!terrainMeetsDetail(fine, options.maxGridSpacingM ?? Infinity)) throw new Error('Global MOLA grid does not meet the requested detail');
  const coarseStart = gridNode(start, coarse), coarseGoal = gridNode(goal, coarse);
  const fineStart = gridNode(start, fine), fineGoal = gridNode(goal, fine);
  if ([coarseStart, coarseGoal, fineStart, fineGoal].some(node => node === null)) throw new Error('Choose points on the Mars map');
  const coarseResult = findRoute(coarse, coarseStart, coarseGoal, {...options, maxGridSpacingM: Infinity});
  if (!coarseResult.path.length) return { path: [], points: [], explored: coarseResult.explored, analysis: analyzeRoute(fine, []), quality: null };
  const coarseCandidates=[coarseResult];
  for(let variant=0;variant<2;variant++){
    const occupied=new Set(coarseCandidates.flatMap(item=>item.path));
    const alternative=findRoute(coarse,coarseStart,coarseGoal,{...options,maxGridSpacingM:Infinity,
      nodePenalty:(node,_previous,step)=>occupied.has(node)?step*(variant+1):0});
    if(alternative.path.length&&alternative.path.some(node=>!occupied.has(node)))coarseCandidates.push(alternative);
  }
  const ratio = fine.width / coarse.width;
  if (!Number.isInteger(ratio) || fine.height !== coarse.height * ratio) throw new Error('Routing grids are not aligned');
  let explored=coarseCandidates.reduce((sum,item)=>sum+item.explored,0),best=null;
  const alternatives=[];
  for(const candidate of coarseCandidates)for (const radius of [2, 5, 10]) {
    const cells = corridor(candidate.path, coarse.width, coarse.height, radius);
    const allowed = node => {
      const x = node % fine.width, y = Math.floor(node / fine.width);
      return cells.has(Math.floor(y / ratio) * coarse.width + Math.floor(x / ratio));
    };
    const result = findRoute(fine, fineStart, fineGoal, {...options, allowed});
    explored+=result.explored;
    if (result.path.length) {
      const points = result.path.map(node => gridToMarsCoordinate(node % fine.width, Math.floor(node / fine.width), fine));
      alternatives.push(points);
      if(!best||result.cost<best.cost)best={path:result.path,points,cost:result.cost,analysis:analyzeRoute(fine,result.path),quality:routeInputQuality(fine,result.path)};
      break;
    }
  }
  return best?{...best,explored,alternativePoints:alternatives.filter(points=>points!==best.points),alternativesCompared:coarseCandidates.length}:
    { path: [], points: [], explored, analysis: analyzeRoute(fine, []), quality: null };
}
