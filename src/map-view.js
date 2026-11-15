import { MapCamera } from './camera.js';
import { clamp, coordinateToGrid, gridToMarsCoordinate } from './terrain.js';
import { imageryLayers, visibleTiles, tileZoom, ImageryTiles } from './imagery.js';
import { clearanceRadius } from './hazard-routing.js';
import { fetchAreaFootprints, pointInGeometry } from './area-catalog.js';

export const places = [
  {name:'Olympus Mons', aliases:['olympus','olympus mons'], lat:18.65, lon:226.20},
  {name:'Valles Marineris', aliases:['valles marineris','valles'], lat:-13.2, lon:288.5},
  {name:'Gale Crater', aliases:['gale','gale crater'], lat:-4.6, lon:137.4},
  {name:'Elysium Planitia', aliases:['elysium','elysium planitia'], lat:4.5, lon:135.9}
];
const palette=[[31,49,52],[74,91,78],[136,128,90],[177,126,81],[207,154,103],[226,199,158],[245,232,206]];
function ramp(t) { const s=clamp(t,0,.99999)*(palette.length-1), i=Math.floor(s); return palette[i].map((c,j)=>c+(palette[i+1][j]-c)*(s-i)); }

export class TerrainMap {
  constructor(canvas, {select, hover, changed}) {
    this.canvas=canvas; this.context=canvas.getContext('2d'); this.camera=new MapCamera(); this.layer='terrain'; this.imageryOpacity={geology:.88,ctx:1,hirise:.85}; this.route=[]; this.routeSegments=[]; this.routeTransitions=[]; this.terrainDepressions=[]; this.hazardSettings={}; this.showTerrainDepressions=true; this.coverageFilter='all'; this.coverage=null; this.coverageCanvas=null; this.localFootprints=[]; this.areaCatalog={ctx:null,hirise:null}; this.areaRequests={}; this.areaOverview={}; this.showMapLabels=true; this.start=null; this.goal=null; this.select=select; this.hover=hover; this.changed=changed; this.pointers=new Map(); this.rasters=new Map();this.tiles=new ImageryTiles(()=>this.draw());
    this.observer=new ResizeObserver(()=>this.resize()); this.observer.observe(canvas);
    canvas.addEventListener('wheel',e=>{e.preventDefault();const p=this.eventPoint(e);this.camera.zoomAt(Math.exp(-clamp(e.deltaY,-100,100)*.003),p.x,p.y);this.draw();},{passive:false});
    canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;
      const p=this.eventPoint(e); this.pointers.set(e.pointerId,p); canvas.setPointerCapture(e.pointerId);
      if(this.pointers.size===1)this.gesture={origin:p,last:p,moved:false};
      else if(this.pointers.size===2){this.gesture.moved=true; this.pinch=this.pinchState();}
    });
    canvas.addEventListener('pointermove',e=>{
      const p=this.eventPoint(e);
      if(this.pointers.has(e.pointerId)) {
        this.pointers.set(e.pointerId,p);
        if(this.pointers.size===2){const next=this.pinchState(); if(this.pinch){this.camera.pan(next.x-this.pinch.x,next.y-this.pinch.y);this.camera.zoomAt(next.distance/Math.max(1,this.pinch.distance),next.x,next.y);}this.pinch=next;}
        else if(this.pointers.size===1){const g=this.gesture; if(Math.hypot(p.x-g.origin.x,p.y-g.origin.y)>5)g.moved=true;if(g.moved)this.camera.pan(p.x-g.last.x,p.y-g.last.y);g.last=p;}
        this.draw();
      } else { const node=this.nodeAt(p); this.hover?.(node,p); }
    });
    const finish=(e,cancel=false)=>{
      const wasSingle=this.pointers.size===1, g=this.gesture, p=this.eventPoint(e);
      this.pointers.delete(e.pointerId); this.pinch=null;
      if(wasSingle&&!cancel&&g&&!g.moved)this.select?.(this.nodeAt(p),e,this.coordinateAt(p));
      if(this.pointers.size===1){const rest=[...this.pointers.values()][0];this.gesture={origin:rest,last:rest,moved:true};}
      if(!this.pointers.size)this.gesture=null;
    };
    canvas.addEventListener('pointerup',e=>finish(e)); canvas.addEventListener('pointercancel',e=>finish(e,true));
    canvas.addEventListener('pointerleave',()=>this.hover?.(null));
    canvas.addEventListener('keydown',e=>{
      const moves={ArrowLeft:[90,0],ArrowRight:[-90,0],ArrowUp:[0,90],ArrowDown:[0,-90]};
      if(moves[e.key])this.camera.pan(...moves[e.key]);else if(e.key==='+'||e.key==='=')this.camera.zoomAt(1.5);else if(e.key==='-')this.camera.zoomAt(1/1.5);else if(e.key==='Home')this.camera.reset();else return;e.preventDefault();this.draw();
    });
  }
  eventPoint(e){const r=this.canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
  pinchState(){const [a,b]=[...this.pointers.values()];return{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y)};}
  coordinateAt(p){if(!this.terrain?.bounds)return null;const q=this.camera.screenToWorld(p.x,p.y),b=this.terrain.bounds;if(q.x<0||q.x>1||q.y<0||q.y>1)return null;return{lat:b.north-q.y*(b.north-b.south),lon:b.west+q.x*(b.east-b.west)};}
  nodeAt(p){if(!this.terrain)return null;const q=this.camera.screenToWorld(p.x,p.y);if(q.x<0||q.x>=1||q.y<0||q.y>=1)return null;return Math.floor(q.y*this.terrain.height)*this.terrain.width+Math.floor(q.x*this.terrain.width);}
  resize(){const r=this.canvas.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(r.width*d);this.canvas.height=Math.round(r.height*d);this.ratio=d;this.camera.resize(r.width,r.height);this.draw();}
  setTerrain(t){this.terrain=t;this.rasters.clear();this.route=[];this.start=this.goal=null;const b=t.bounds;const aspect=b?(b.east-b.west)/(b.north-b.south)*(t.id==='mars-global'?1:Math.cos((b.north+b.south)/2*Math.PI/180)):t.width/t.height;this.camera.resize(this.camera.width,this.camera.height,aspect);this.camera.reset();this.setLayer(this.layer);}
  setImageryIndex(files){this.tiles.setLocal(files);this.draw();}
  setLayer(layer){this.layer=layer;this.camera.maxZoom=layer==='hirise'?131072:layer==='ctx'?8192:256;this.camera.zoom=Math.min(this.camera.zoom,this.camera.maxZoom);this.camera.constrain();this.draw();}
  setImageryOpacity(layer,value){this.imageryOpacity[layer]=clamp(value,0,1);this.draw();}
  setRoute(path,start,goal,segments=[],transitions=[]){this.route=path;this.routeSegments=segments;this.routeTransitions=transitions;this.start=start;this.goal=goal;this.draw();}
  setCoverage(coverage){this.coverage=coverage;this.coverageCanvas=null;this.draw();}
  setCoverageFilter(filter){this.coverageFilter=filter;this.coverageCanvas=null;this.draw();}
  setShowMapLabels(value){this.showMapLabels=Boolean(value);this.draw();}
  setTerrainDepressions(hazards){this.terrainDepressions=hazards??[];this.draw();}
  setShowTerrainDepressions(value){this.showTerrainDepressions=Boolean(value);this.draw();}
  setLocalFootprint(source,geometry){this.setLocalFootprints(source&&geometry?[{source,geometry}]:[]);}
  setLocalFootprints(footprints){this.localFootprints=footprints.filter(item=>item.source&&item.geometry);this.draw();}
  visibleAreaBounds(){
    if(!this.terrain?.bounds)return null;
    const a=this.camera.screenToWorld(0,0),b=this.camera.screenToWorld(this.camera.width,this.camera.height),map=this.terrain.bounds;
    const west=map.west+clamp(Math.min(a.x,b.x),0,1)*(map.east-map.west);
    const east=map.west+clamp(Math.max(a.x,b.x),0,1)*(map.east-map.west);
    const north=map.north-clamp(Math.min(a.y,b.y),0,1)*(map.north-map.south);
    const south=map.north-clamp(Math.max(a.y,b.y),0,1)*(map.north-map.south);
    return east>west&&north>south?{west,east,south,north}:null;
  }
  areaSources(){return this.coverageFilter==='all'?['ctx','hirise']:
    ['ctx','hirise'].includes(this.coverageFilter)?[this.coverageFilter]:[];}
  loadAreaOverview(){
    for(const source of this.areaSources()){
      if(this.areaOverview[source])continue;
      const image=new Image(),entry={image,state:'loading'};this.areaOverview[source]=entry;
      image.onload=()=>{entry.state='ready';this.draw();};
      image.onerror=()=>{entry.state='error';this.draw();};
      image.src=`data/area-${source}.png`;
    }
  }
  areaContained(outer,inner){return outer&&inner&&outer.west<=inner.west&&outer.east>=inner.east&&outer.south<=inner.south&&outer.north>=inner.north;}
  updateAreaCatalog(view){
    if(!view||view.east-view.west>30||view.north-view.south>30)return;
    for(const source of this.areaSources()){
      const previous=this.areaCatalog[source],span=Math.max(view.east-view.west,view.north-view.south);
      if(this.areaContained(previous?.bounds,view)&&(!previous.truncated&&!previous.error||span>=previous.viewSpan*.8))continue;
      if(this.areaContained(this.areaRequests[source]?.bounds,view))continue;
      this.areaRequests[source]?.controller.abort();
      const padLon=Math.max(.05,(view.east-view.west)*.25),padLat=Math.max(.05,(view.north-view.south)*.25);
      const bounds={west:Math.max(0,view.west-padLon),east:Math.min(360,view.east+padLon),
        south:Math.max(-90,view.south-padLat),north:Math.min(90,view.north+padLat)};
      const controller=new AbortController(),request={bounds,controller,viewSpan:span};this.areaRequests[source]=request;
      fetchAreaFootprints(source,bounds,{signal:controller.signal}).then(result=>{
        if(this.areaRequests[source]!==request)return;
        this.areaCatalog[source]={...result,bounds,viewSpan:span};delete this.areaRequests[source];this.draw();
      }).catch(error=>{
        if(this.areaRequests[source]!==request)return;
        delete this.areaRequests[source];
        if(error?.name!=='AbortError'){this.areaCatalog[source]={bounds,viewSpan:span,features:[],error:error.message};this.draw();}
      });
    }
  }
  areaStatus(view){
    if(this.coverageFilter==='none')return 'Area overlays hidden';
    const base=this.coverageFilter==='all'?'HRSC/MOLA source guide · approximate':this.coverageFilter==='hrsc'?'HRSC footprint guide · approximate':this.coverageFilter==='mola'?'MOLA base guide · approximate':'';
    const sources=this.areaSources();if(!sources.length)return base;
    if(!view||view.east-view.west>30||view.north-view.south>30){
      const previews=sources.map(source=>`${source.toUpperCase()} ${this.areaOverview[source]?.state==='ready'?'overview':this.areaOverview[source]?.state==='error'?'overview unavailable':'overview loading'}`);
      return [base,...previews,'Approximate DTM footprint shading; zoom in to ≤30° for catalogue polygons'].filter(Boolean).join(' · ');
    }
    const notes=sources.map(source=>{
      const catalog=this.areaCatalog[source];
      if(!this.areaContained(catalog?.bounds,view))return `${source.toUpperCase()} footprints loading`;
      if(catalog.error)return `${source.toUpperCase()} catalogue unavailable`;
      if(catalog.truncated)return `${source.toUpperCase()} preview only (over 500 results); zoom in for exact polygons`;
      return `${source.toUpperCase()} ${catalog.features.length} DTM footprints`;
    });
    return [base,...notes,'Shading shows catalogue extents, which can contain missing heights; route colors mark heights actually used'].filter(Boolean).join(' · ');
  }
  areaAt(point){
    if(!point||this.coverageFilter==='none')return null;
    const lon=point.lon>180?point.lon-360:point.lon,view=this.visibleAreaBounds();
    for(const source of ['hirise','ctx']){
      if(!this.areaSources().includes(source))continue;
      const catalog=this.areaCatalog[source];
      if(!this.areaContained(catalog?.bounds,view)||catalog.truncated||catalog.error)continue;
      for(const feature of catalog.features){
        const box=feature.bbox;
        if(box&&(lon<box[0]||lon>box[2]||point.lat<box[1]||point.lat>box[3]))continue;
        if(pointInGeometry(lon,point.lat,feature.geometry))return feature;
      }
    }
    return null;
  }
  coverageRaster(kind){
    if(!this.coverage)return null;
    if(this.coverageCanvas?.kind===kind)return this.coverageCanvas.canvas;
    const mask=this.coverage,w=mask.width,h=mask.height;
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const context=canvas.getContext('2d'),image=context.createImageData(w,h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const bit=y*w+x,covered=Boolean(mask.bytes[bit>>3]&(128>>(bit&7)));
      if(kind==='all'||(kind==='hrsc')===covered){const at=(y*w+x)*4;image.data[at]=covered?145:235;image.data[at+1]=covered?240:159;image.data[at+2]=covered?96:83;image.data[at+3]=115;}
    }
    context.putImageData(image,0,0);this.coverageCanvas={kind,canvas};return canvas;
  }
  drawCoverage(ctx,frame){
    if(!this.coverage||this.coverageFilter==='none')return;
    const kind=['all','hrsc','mola'].includes(this.coverageFilter)?this.coverageFilter:null;
    if(!kind)return;
    ctx.save();ctx.beginPath();ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.clip();
    // The global source guide is contextual and must not obscure orbital imagery.
    ctx.globalAlpha=this.coverageFilter==='all' ? .24 : .55;
    const canvas=this.coverageRaster(kind),half=canvas.width/2;
    ctx.drawImage(canvas,half,0,half,canvas.height,frame.x,frame.y,frame.w/2,frame.h);
    ctx.drawImage(canvas,0,0,half,canvas.height,frame.x+frame.w/2,frame.y,frame.w/2,frame.h);
    ctx.restore();
  }
  drawGeometry(ctx,geometry){
    const polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:[];
    for(const polygon of polygons){
      const exterior=polygon[0];if(!exterior?.length)continue;
      const lons=exterior.map(([lon])=>(lon+360)%360),crossesSeam=Math.max(...lons)-Math.min(...lons)>180;
      for(const shift of crossesSeam?[0,-360]:[0]){
        ctx.beginPath();
        for(const ring of polygon){
          ring.forEach(([rawLon,lat],index)=>{
            const normalized=(rawLon+360)%360,lon=(crossesSeam&&normalized<180?normalized+360:normalized)+shift;
            const p=this.coordinatePoint({lat,lon});if(index)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);
          });
          ctx.closePath();
        }
        ctx.fill('evenodd');ctx.stroke();
      }
    }
  }
  drawCatalogFootprints(ctx,view){
    if(this.coverageFilter==='none')return;
    const f=this.camera.frame;ctx.save();ctx.beginPath();ctx.rect(f.x,f.y,f.w,f.h);ctx.clip();
    for(const source of this.areaSources()){
      const catalog=this.areaCatalog[source];
      if(!this.areaContained(catalog?.bounds,view)||catalog.truncated||catalog.error)continue;
      ctx.fillStyle=source==='hirise'?'#75d9ed25':'#e9b0f025';
      ctx.strokeStyle=source==='hirise'?'#75d9edbd':'#e9b0f0bd';ctx.lineWidth=1;
      ctx.setLineDash([4,3]);
      for(const feature of catalog.features)this.drawGeometry(ctx,feature.geometry);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }
  drawAreaOverview(ctx,view){
    if(this.coverageFilter==='none')return;
    const frame=this.camera.frame;ctx.save();ctx.beginPath();ctx.rect(frame.x,frame.y,frame.w,frame.h);ctx.clip();
    for(const source of this.areaSources()){
      const catalog=this.areaCatalog[source];
      if(this.areaContained(catalog?.bounds,view)&&!catalog.truncated&&!catalog.error)continue;
      const entry=this.areaOverview[source];if(entry?.state!=='ready')continue;
      const canvas=entry.image;
      ctx.globalAlpha=this.coverageFilter==='all'?.7:1;
      // DTM previews are rasterized in the same 0–360° east order as this map.
      ctx.drawImage(canvas,0,0,canvas.width,canvas.height,frame.x,frame.y,frame.w,frame.h);
      ctx.globalAlpha=1;
    }
    ctx.restore();
  }
  drawLocalFootprint(ctx){
    if(this.coverageFilter==='none')return;
    const f=this.camera.frame;ctx.save();ctx.beginPath();ctx.rect(f.x,f.y,f.w,f.h);ctx.clip();
    for(const footprint of this.localFootprints){
      if(!(this.coverageFilter==='all'||this.coverageFilter===footprint.source))continue;
      ctx.fillStyle=footprint.source==='hirise'?'#75d9ed52':'#e9b0f052';
      ctx.strokeStyle=footprint.source==='hirise'?'#75d9ed':'#e9b0f0';ctx.lineWidth=1.7;
      this.drawGeometry(ctx,footprint.geometry);
    }
    ctx.restore();
  }
  drawTerrainDepressions(ctx){
    if(!this.showTerrainDepressions||!this.terrainDepressions.length)return;
    const f=this.camera.frame,b=this.terrain.bounds,R=3396190;
    ctx.save();ctx.beginPath();ctx.rect(f.x,f.y,f.w,f.h);ctx.clip();
    for(const hazard of this.terrainDepressions.filter(item=>item.score>=.84).slice(0,80)){
      const p=this.coordinatePoint(hazard),radius=clearanceRadius(hazard,this.hazardSettings);
      const rx=radius/(R*Math.max(.02,Math.cos(hazard.lat*Math.PI/180)))*180/Math.PI/(b.east-b.west)*f.w;
      const ry=radius/R*180/Math.PI/(b.north-b.south)*f.h;
      if(p.x+rx<0||p.x-rx>this.camera.width||p.y+ry<0||p.y-ry>this.camera.height)continue;
      ctx.beginPath();ctx.ellipse(p.x,p.y,Math.max(2,rx),Math.max(2,ry),0,0,Math.PI*2);
      ctx.fillStyle='#fb57472e';
      ctx.strokeStyle='#ff7865';
      ctx.lineWidth=1.6;ctx.fill();ctx.stroke();
      if(this.showMapLabels&&rx>6){ctx.fillStyle='#fff1cc';ctx.font='10px ui-monospace';
        ctx.fillText(`${hazard.source.toUpperCase()} depression ~${hazard.demDepthM} m`,p.x+rx+4,p.y);}
    }
    ctx.restore();
  }
  traceRoute(ctx,from,to){
    if(to<=from)return;
    ctx.beginPath();let first=this.coordinatePoint(this.route[from]);ctx.moveTo(first.x,first.y);
    for(let i=from+1;i<=to;i++){
      const point=this.route[i],previous=this.route[i-1],p=this.coordinatePoint(point);
      if(Math.abs(point.lon-previous.lon)<=180){ctx.lineTo(p.x,p.y);continue;}
      const right=previous.lon>point.lon,edgeLon=right?360:0,nextLon=right?point.lon+360:point.lon-360;
      const fraction=(edgeLon-previous.lon)/(nextLon-previous.lon),edgeLat=previous.lat+(point.lat-previous.lat)*fraction;
      const exit=this.coordinatePoint({lat:edgeLat,lon:edgeLon}),enter=this.coordinatePoint({lat:edgeLat,lon:right?0:360});
      ctx.lineTo(exit.x,exit.y);ctx.moveTo(enter.x,enter.y);ctx.lineTo(p.x,p.y);
    }
  }
  transitionAt(position){
    for(const transition of this.routeTransitions){const p=this.coordinatePoint(transition.point);if(Math.hypot(p.x-position.x,p.y-position.y)<11)return transition;}
    return null;
  }
  focus(lat,lon,zoom=8){const b=this.terrain.bounds;if(b){if(lat<b.south||lat>b.north||lon<b.west||lon>b.east)return false;this.camera.focus((lon-b.west)/(b.east-b.west),(b.north-lat)/(b.north-b.south),zoom);}else{const p=coordinateToGrid(lat,lon,this.terrain);if(!p)return false;this.camera.focus((p.x+.5)/this.terrain.width,(p.y+.5)/this.terrain.height,zoom);}this.draw();return true;}
  raster(layer=this.layer){
    if(this.rasters.has(layer))return this.rasters.get(layer);
    const t=this.terrain,c=document.createElement('canvas');c.width=t.width;c.height=t.height;const ctx=c.getContext('2d'),im=ctx.createImageData(t.width,t.height),range=Math.max(1,t.max-t.min);
    for(let i=0;i<t.elevation.length;i++){
      const h=t.elevation[i];if(!Number.isFinite(h))continue;
      let col=layer==='slope'?[45+210*clamp(t.slopes[i]/30,0,1),140-95*clamp(t.slopes[i]/30,0,1),92-55*clamp(t.slopes[i]/30,0,1)]:ramp((h-t.min)/range);
      if(layer==='terrain'){
        const x=i%t.width,y=Math.floor(i/t.width),l=t.elevation[y*t.width+Math.max(0,x-1)],r=t.elevation[y*t.width+Math.min(t.width-1,x+1)],u=t.elevation[Math.max(0,y-1)*t.width+x],d=t.elevation[Math.min(t.height-1,y+1)*t.width+x];
        // Display-only relief exaggeration; routing always uses unmodified elevations.
        const shade=clamp(.88+(l-r+u-d)/(t.cellKm*1000)*1.6,.28,1.25);col=col.map(v=>v*shade);
      }
      im.data.set([...col.map(v=>Math.round(clamp(v,0,255))),255],i*4);
    }
    ctx.putImageData(im,0,0);this.rasters.set(layer,c);return c;
  }
  drawTileLayer(layer,zoom,ctx,W,H,opacity=1){
    const t=this.terrain,f=this.camera.frame,spec=imageryLayers[layer];
    const tiles=visibleTiles(layer,t.bounds,f,{width:W,height:H},zoom);
    const result={total:tiles.length,ready:0,failed:0,zoom};
    ctx.save();ctx.beginPath();ctx.rect(f.x,f.y,f.w,f.h);ctx.clip();
    const a=this.camera.worldToScreen((spec.coverage.west-t.bounds.west)/(t.bounds.east-t.bounds.west),(t.bounds.north-spec.coverage.north)/(t.bounds.north-t.bounds.south));
    const b=this.camera.worldToScreen((spec.coverage.east-t.bounds.west)/(t.bounds.east-t.bounds.west),(t.bounds.north-spec.coverage.south)/(t.bounds.north-t.bounds.south));
    ctx.beginPath();ctx.rect(a.x,a.y,b.x-a.x,b.y-a.y);ctx.clip();ctx.globalAlpha=opacity;
    for(const tile of tiles){
      const entry=this.tiles.get(layer,tile);
      if(entry.state==='ready'){
        // A small overlap hides fractional-pixel seams between adjacent tiles.
        ctx.drawImage(entry.image,tile.x,tile.y,tile.w+.75,tile.h+.75);result.ready++;
      }else if(entry.state==='error')result.failed++;
    }
    ctx.restore();return result;
  }
  draw(){
    const ctx=this.context,W=this.camera.width,H=this.camera.height;ctx.setTransform(this.ratio||1,0,0,this.ratio||1,0,0);ctx.clearRect(0,0,W,H);if(!this.terrain)return;
    const areaView=this.visibleAreaBounds();if(this.layer!=='geology'){this.loadAreaOverview();this.updateAreaCatalog(areaView);}
    const t=this.terrain,f=this.camera.frame,imageryMode=Boolean(imageryLayers[this.layer]);
    if(this.layer==='geology'){ctx.imageSmoothingEnabled=this.camera.zoom<5;ctx.drawImage(this.raster('terrain'),f.x,f.y,f.w,f.h);}
    else if(imageryMode){ctx.fillStyle='#343d39';ctx.fillRect(f.x,f.y,f.w,f.h);}
    else{ctx.imageSmoothingEnabled=this.camera.zoom<5;ctx.drawImage(this.raster(),f.x,f.y,f.w,f.h);}
    let imagery=null;
    if(imageryMode&&t.bounds){
      ctx.imageSmoothingEnabled=true;
      if(this.layer==='geology'){
        const spec=imageryLayers.geology,z=tileZoom(f.w,t.bounds.east-t.bounds.west,spec.maxZoom,spec.tilePixels,360);
        if(z>0)this.drawTileLayer('geology',z-1,ctx,W,H,this.imageryOpacity.geology);
        imagery=this.drawTileLayer('geology',z,ctx,W,H,this.imageryOpacity.geology);
      }
      if(this.layer==='viking'||this.layer==='hirise'){
        const viking=imageryLayers.viking,vikingZoom=tileZoom(f.w,t.bounds.east-t.bounds.west,viking.maxZoom,viking.tilePixels);
        const overviewZoom=Math.min(2,vikingZoom);
        const overview=this.drawTileLayer('viking',overviewZoom,ctx,W,H);
        if(vikingZoom>overviewZoom+1)this.drawTileLayer('viking',vikingZoom-1,ctx,W,H);
        const vikingDetail=vikingZoom>overviewZoom?this.drawTileLayer('viking',vikingZoom,ctx,W,H):overview;
        if(this.layer==='viking')imagery=vikingDetail;
      }
      if(this.layer==='ctx'||this.layer==='hirise'){
        const spec=imageryLayers[this.layer],z=tileZoom(f.w,t.bounds.east-t.bounds.west,spec.maxZoom,spec.tilePixels);
        if(this.layer==='ctx'){
          const baseZoom=Math.min(2,z);
          this.drawTileLayer('ctx',baseZoom,ctx,W,H,this.imageryOpacity.ctx);
          if(z>baseZoom+1)this.drawTileLayer('ctx',z-1,ctx,W,H,this.imageryOpacity.ctx);
          imagery=z>baseZoom?this.drawTileLayer('ctx',z,ctx,W,H,this.imageryOpacity.ctx):{zoom:z,total:0,ready:0,failed:0};
        }else{
          // Viking remains visible wherever the current HiRISE mosaic has no image.
          // A coarse HiRISE overview would leave enlarged rectangular artifacts.
          if(z>2)this.drawTileLayer('hirise',z-1,ctx,W,H,this.imageryOpacity.hirise);
          imagery=this.drawTileLayer('hirise',z,ctx,W,H,this.imageryOpacity.hirise);
        }
      }
    }
    if(this.layer!=='geology'){
      this.drawCoverage(ctx,f);
      this.drawAreaOverview(ctx,areaView);
      this.drawCatalogFootprints(ctx,areaView);
      this.drawLocalFootprint(ctx);
    }
    this.drawTerrainDepressions(ctx);
    ctx.save();ctx.beginPath();ctx.rect(f.x,f.y,f.w,f.h);ctx.clip();
    ctx.strokeStyle='#ecf0d422';ctx.lineWidth=.6;
    for(let i=1;i<8;i++){const x=f.x+f.w*i/8;ctx.beginPath();ctx.moveTo(x,f.y);ctx.lineTo(x,f.y+f.h);ctx.stroke();}
    for(let i=1;i<4;i++){const y=f.y+f.h*i/4;ctx.beginPath();ctx.moveTo(f.x,y);ctx.lineTo(f.x+f.w,y);ctx.stroke();}
    if(this.showMapLabels&&this.layer!=='geology'&&t.bounds)for(const place of places){const p=coordinateToGrid(place.lat,place.lon,t);if(!p)continue;const v=this.camera.worldToScreen((p.x+.5)/t.width,(p.y+.5)/t.height);ctx.fillStyle='#f8f5e9';ctx.beginPath();ctx.arc(v.x,v.y,3,0,Math.PI*2);ctx.fill();ctx.font='11px system-ui';ctx.textAlign='left';ctx.lineWidth=3;ctx.strokeStyle='#161b13';ctx.strokeText(place.name,v.x+8,v.y-8);ctx.fillText(place.name,v.x+8,v.y-8);}
    if(this.route.length){
      this.traceRoute(ctx,0,this.route.length-1);
      ctx.strokeStyle='#161b13d9';ctx.lineWidth=7;ctx.lineJoin='round';ctx.stroke();
      if(this.routeSegments.length)for(const segment of this.routeSegments){
        this.traceRoute(ctx,segment.from,segment.to);
        ctx.strokeStyle={hrsc:'#a7ff78',mola:'#ffb578',ctx:'#e9b0f0',hirise:'#75d9ed',unverified:'#ffe083'}[segment.source]??'#e4ff83';
        ctx.globalAlpha=!['all','none',segment.source].includes(this.coverageFilter)?.18:1;
        ctx.lineWidth=3.5;ctx.stroke();
      }else{ctx.strokeStyle='#e4ff83';ctx.lineWidth=3;ctx.stroke();}
      ctx.globalAlpha=1;
      for(const transition of this.routeTransitions){const p=this.coordinatePoint(transition.point);
        ctx.beginPath();ctx.arc(p.x,p.y,5,0,Math.PI*2);ctx.fillStyle={hrsc:'#a7ff78',mola:'#ffb578',ctx:'#e9b0f0',hirise:'#75d9ed',unverified:'#ffe083'}[transition.source]??'#e4ff83';ctx.fill();
        ctx.strokeStyle='#151a12';ctx.lineWidth=2;ctx.stroke();
      }
    }
    for(const [point,color,label]of[[this.start,'#dcf283','A'],[this.goal,'#f0774a','B']])if(point){const p=this.coordinatePoint(point);ctx.beginPath();ctx.arc(p.x,p.y,11,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#172010';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='#172010';ctx.font='bold 11px system-ui';ctx.textAlign='center';ctx.fillText(label,p.x,p.y+4);}
    ctx.restore();
    const center=this.camera.screenToWorld(W/2,H/2),lat=t.bounds?t.bounds.north-center.y*(t.bounds.north-t.bounds.south):18.5;
    const horizontalKm=t.bounds?(t.bounds.east-t.bounds.west)*Math.PI/180*t.radiusKm*Math.cos(lat*Math.PI/180):t.width*t.cellKm;
    if(imagery){const spec=imageryLayers[this.layer];imagery.pixelKm=t.radiusKm*Math.PI/180*Math.cos(lat*Math.PI/180)*((spec.provider==='usgs-geology'?360:180)/2**imagery.zoom)/spec.tilePixels;}
    this.changed?.({zoom:this.camera.zoom,maxZoom:this.camera.maxZoom,scaleKm:80/f.w*horizontalKm,imagery,areaStatus:this.layer==='geology'?'USGS SIM 3292 global geology · terrain coverage overlays hidden in this view':this.areaStatus(areaView)});
  }
  nodePoint(n){const t=this.terrain;return this.camera.worldToScreen((n%t.width+.5)/t.width,(Math.floor(n/t.width)+.5)/t.height);}
  coordinatePoint(point){const b=this.terrain.bounds;return this.camera.worldToScreen((point.lon-b.west)/(b.east-b.west),(b.north-point.lat)/(b.north-b.south));}
}
