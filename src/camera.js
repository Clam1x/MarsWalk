import { clamp } from './terrain.js';

export class MapCamera {
  constructor() { this.zoom = 1; this.maxZoom = 32; this.cx = .5; this.cy = .5; this.width = 1; this.height = 1; this.aspect = 2; }
  resize(width, height, aspect = this.aspect) { this.width = width; this.height = height; this.aspect = aspect; this.constrain(); }
  get frame() {
    const w = Math.min(this.width, this.height * this.aspect) * this.zoom;
    const h = w / this.aspect;
    return { w, h, x: this.width / 2 - this.cx * w, y: this.height / 2 - this.cy * h };
  }
  constrain() {
    const { w, h } = this.frame;
    this.cx = w <= this.width ? .5 : clamp(this.cx, this.width / (2*w), 1-this.width/(2*w));
    this.cy = h <= this.height ? .5 : clamp(this.cy, this.height / (2*h), 1-this.height/(2*h));
  }
  screenToWorld(x, y) { const f = this.frame; return { x: (x-f.x)/f.w, y: (y-f.y)/f.h }; }
  worldToScreen(x, y) { const f = this.frame; return { x: f.x+x*f.w, y:f.y+y*f.h }; }
  pan(dx, dy) { const f=this.frame; this.cx-=dx/f.w; this.cy-=dy/f.h; this.constrain(); }
  zoomAt(factor, x=this.width/2, y=this.height/2) {
    const before=this.screenToWorld(x,y);
    this.zoom=clamp(this.zoom*factor,1,this.maxZoom);
    const after=this.screenToWorld(x,y);
    this.cx+=before.x-after.x; this.cy+=before.y-after.y; this.constrain();
  }
  focus(x,y,zoom=8) { this.cx=x; this.cy=y; this.zoom=clamp(zoom,1,this.maxZoom); this.constrain(); }
  reset() { this.focus(.5,.5,1); }
}

export function parseCoordinates(text) {
  const parts=text.trim().split(/\s*[,;]\s*/);
  if(parts.length!==2 || parts.some(p=>!p || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p))) return null;
  const [lat,lon]=parts.map(Number);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat < -90||lat > 90||lon < -180||lon > 360) return null;
  return {lat,lon:((lon%360)+360)%360};
}
