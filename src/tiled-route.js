import {cellMetrics} from './accuracy.js';
import {terrainDistanceKm} from './terrain.js';

class Queue {
  items=[];
  push(value){
    const items=this.items;let i=items.length;items.push(value);
    while(i){const parent=(i-1)>>1;if(items[parent].priority<=value.priority)break;items[i]=items[parent];i=parent;}
    items[i]=value;
  }
  pop(){
    const items=this.items,head=items[0],tail=items.pop();
    if(items.length){let i=0;for(;;){let child=i*2+1;if(child>=items.length)break;if(child+1<items.length&&items[child+1].priority<items[child].priority)child++;if(items[child].priority>=tail.priority)break;items[i]=items[child];i=child;}items[i]=tail;}
    return head;
  }
  get size(){return this.items.length;}
}

export class NativeTileStore {
  constructor(terrain,readWindow,{tileSize=128,maxTiles=256}={}){
    this.terrain=terrain;this.readWindow=readWindow;this.tileSize=tileSize;this.maxTiles=maxTiles;this.tiles=new Map();this.readCount=0;
  }
  async ensure(left,top,right,bottom){
    const size=this.tileSize,requests=[];
    for(let ty=Math.floor(Math.max(0,top)/size);ty<=Math.floor((Math.min(this.terrain.height,bottom)-1)/size);ty++)
      for(let tx=Math.floor(Math.max(0,left)/size);tx<=Math.floor((Math.min(this.terrain.width,right)-1)/size);tx++){
        const key=`${tx},${ty}`;if(this.tiles.has(key))continue;
        if(this.tiles.size>=this.maxTiles)throw new Error('Native DTM tile budget exceeded; choose a shorter route or a coarser source.');
        const x=tx*size,y=ty*size,w=Math.min(size,this.terrain.width-x),h=Math.min(size,this.terrain.height-y);
        const promise=Promise.resolve(this.readWindow(x,y,w,h)).then(values=>{
          if(values.length!==w*h)throw new Error('DTM tile has unexpected dimensions');
          this.readCount++;return {values,width:w,height:h};
        }).catch(error=>{this.tiles.delete(key);throw error;});
        this.tiles.set(key,promise);requests.push(promise);
      }
    await Promise.all(requests);
  }
  heightAt(node){
    if(!Number.isInteger(node)||node<0||node>=this.terrain.width*this.terrain.height)return NaN;
    const x=node%this.terrain.width,y=Math.floor(node/this.terrain.width),size=this.tileSize;
    const tile=this.tiles.get(`${Math.floor(x/size)},${Math.floor(y/size)}`);
    if(!tile||!tile.value)return NaN;
    const {values,width}=tile.value;
    return values[(y%size)*width+x%size];
  }
  async ensureAndResolve(left,top,right,bottom){
    await this.ensure(left,top,right,bottom);
    // Promises are kept for deduplicated concurrent reads; cache their resolved tile.
    const size=this.tileSize;
    for(let ty=Math.floor(Math.max(0,top)/size);ty<=Math.floor((Math.min(this.terrain.height,bottom)-1)/size);ty++)
      for(let tx=Math.floor(Math.max(0,left)/size);tx<=Math.floor((Math.min(this.terrain.width,right)-1)/size);tx++){
        const key=`${tx},${ty}`,entry=this.tiles.get(key);if(entry&&!entry.value)entry.value=await entry;
      }
  }
  async ensurePoints(points){
    const size=this.tileSize,tiles=new Map();
    for(const point of points){
      const x=Math.round(point.x),y=Math.round(point.y);
      if(x<0||y<0||x>=this.terrain.width||y>=this.terrain.height)continue;
      const tx=Math.floor(x/size),ty=Math.floor(y/size);
      tiles.set(`${tx},${ty}`,{x:tx*size,y:ty*size});
    }
    const unique=[...tiles.values()];
    for(let index=0;index<unique.length;index+=4)await Promise.all(unique.slice(index,index+4).map(tile=>
      this.ensureAndResolve(tile.x,tile.y,tile.x+1,tile.y+1)));
  }
}

const directions=[[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
const degrees=(rise,run)=>Math.atan2(Math.abs(rise),run)*180/Math.PI;

// Searches the complete native grid. Tiles are fetched only as the frontier reaches them.
// A finite search budget is reported, never converted into a coarse "native" result.
export async function findTiledPedestrianRoute(terrain,store,start,goal,options={}){
  const width=terrain.width,height=terrain.height;
  const slopeLimit=options.slopeLimit??12,crossSlopeLimit=options.crossSlopeLimit??slopeLimit;
  const stepLimitM=options.stepLimitM??0.6,radiusM=options.radiusM??1;
  const exclusionCircles=options.exclusionCircles??[];
  const maxExplored=options.maxExplored??600000;
  if(!(slopeLimit>0&&crossSlopeLimit>0&&stepLimitM>0&&radiusM>=0))throw new RangeError('Invalid pedestrian limits');
  const metrics=cellMetrics(terrain,start),requiredSpan=Math.max(1,Math.ceil(radiusM/Math.min(metrics.eastWestM,metrics.northSouthM))+1);
  if(requiredSpan>4)throw new Error('Walking clearance is wider than the supported native-grid check.');
  const span=requiredSpan;
  const walkable=new Map(),edgeCache=new Map(),scores=new Map([[start,0]]),previous=new Map(),closed=new Set(),queue=new Queue();
  const heightAt=node=>store.heightAt(node);
  const xOf=node=>node%width,yOf=node=>Math.floor(node/width);
  const clearance=node=>{
    if(walkable.has(node))return walkable.get(node);
    const x=xOf(node),y=yOf(node),base=heightAt(node),{eastWestM,northSouthM,centreOffsetM}=cellMetrics(terrain,node);
    let okay=Number.isFinite(base)&&base!==terrain.noData;
    if(okay&&exclusionCircles.some(circle=>
      Math.hypot((x-circle.x)*eastWestM,(y-circle.y)*northSouthM)<=circle.radiusM+radiusM+centreOffsetM))okay=false;
    for(let dy=-span;dy<=span&&okay;dy++)for(let dx=-span;dx<=span;dx++){
      const separation=Math.hypot(dx*eastWestM,dy*northSouthM);
      if(separation>radiusM+centreOffsetM)continue;
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height){okay=false;break;}
      const other=heightAt(ny*width+nx);
      if(!Number.isFinite(other)||other===terrain.noData){okay=false;break;}
      if(separation>0&&Math.max(eastWestM,northSouthM)<=2.5&&separation<=2.5&&Math.abs(other-base)>stepLimitM){okay=false;break;}
    }
    walkable.set(node,okay);return okay;
  };
  const edge=(from,to)=>{
    const key=from<to?`${from},${to}`:`${to},${from}`;
    if(edgeCache.has(key))return edgeCache.get(key);
    let value=null;
    if(clearance(from)&&clearance(to)){
      const fx=xOf(from),fy=yOf(from),tx=xOf(to),ty=yOf(to),dx=tx-fx,dy=ty-fy;
      const runM=terrainDistanceKm(terrain,from,to)*1000,along=degrees(heightAt(to)-heightAt(from),runM);
      const nativeSpacing=cellMetrics(terrain,from);
      if(along<=slopeLimit&&(Math.max(nativeSpacing.eastWestM,nativeSpacing.northSouthM)>2.5||
        Math.abs(heightAt(to)-heightAt(from))<=stepLimitM)){
        const ax=fx-dy,ay=fy+dx,bx=fx+dy,by=fy-dx;
        if(ax>=0&&ay>=0&&bx>=0&&by>=0&&ax<width&&bx<width&&ay<height&&by<height){
          const sideA=ay*width+ax,sideB=by*width+bx;
          if(clearance(sideA)&&clearance(sideB)){
            const across=degrees(heightAt(sideA)-heightAt(sideB),terrainDistanceKm(terrain,sideA,sideB)*1000);
            if(across<=crossSlopeLimit)value={along,across,runKm:runM/1000};
          }
        }
      }
    }
    if(edgeCache.size>=80000)edgeCache.clear();
    edgeCache.set(key,value);return value;
  };
  const estimate=node=>terrainDistanceKm(terrain,node,goal);
  queue.push({node:start,priority:estimate(start)});
  let explored=0;
  while(queue.size){
    const node=queue.pop().node;if(closed.has(node))continue;
    const x=xOf(node),y=yOf(node);
    await store.ensureAndResolve(x-span-2,y-span-2,x+span+3,y+span+3);
    if(!clearance(node)){closed.add(node);continue;}
    closed.add(node);explored++;
    if(explored>maxExplored)throw new Error('Native DTM search budget exceeded; choose a shorter route or a coarser source.');
    if(node===goal){
      const path=[];for(let cursor=goal;cursor!==undefined;cursor=previous.get(cursor))path.push(cursor);
      path.reverse();let maxCrossSlope=0;
      for(let i=1;i<path.length;i++)maxCrossSlope=Math.max(maxCrossSlope,edge(path[i-1],path[i])?.across??0);
      return {path,explored,cost:scores.get(goal),maxCrossSlope,tileCount:store.readCount};
    }
    for(const [dx,dy] of directions){
      const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=width||ny>=height)continue;
      const next=ny*width+nx;if(closed.has(next))continue;
      const check=edge(node,next);if(!check)continue;
      const gradePenalty=(check.along/slopeLimit)**2*3,crossPenalty=(check.across/crossSlopeLimit)**2*2;
      const tentative=scores.get(node)+check.runKm*(1+gradePenalty+crossPenalty);
      if(tentative<(scores.get(next)??Infinity)){
        scores.set(next,tentative);previous.set(next,node);
        queue.push({node:next,priority:tentative+estimate(next)});
      }
    }
    if(explored%10000===0)options.onProgress?.(explored,store.readCount);
  }
  return {path:[],explored,cost:Infinity,maxCrossSlope:Infinity,tileCount:store.readCount};
}
