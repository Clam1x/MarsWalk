export function drawProfile(canvas, analysis) {
  const ratio=Math.min(devicePixelRatio||1,2),rect=canvas.getBoundingClientRect();canvas.width=Math.round(rect.width*ratio);canvas.height=Math.round(rect.height*ratio);
  const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);const w=rect.width,h=rect.height,p={l:60,r:15,t:12,b:25},gw=w-p.l-p.r,gh=h-p.t-p.b;
  if(!analysis?.elevations.length){ctx.fillStyle='#858b79';ctx.font='12px system-ui';ctx.textAlign='center';ctx.fillText('Elevation profile appears here',w/2,h/2);return;}
  const a=analysis,[minimum,maximum]=a.elevations.reduce(([lo,hi],v)=>Number.isFinite(v)?[Math.min(lo,v),Math.max(hi,v)]:[lo,hi],[Infinity,-Infinity]);
  if(!Number.isFinite(minimum)||!Number.isFinite(maximum))return;
  const lo=minimum-30,hi=maximum+30,total=a.distanceKm;
  ctx.font='9px ui-monospace';ctx.fillStyle='#6a6d61';ctx.textAlign='right';
  for(let i=0;i<=3;i++){const y=p.t+gh*i/3;ctx.strokeStyle='#d6d8ca';ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(`${Math.round(hi-(hi-lo)*i/3)} m`,p.l-7,y+3);}
  const points=a.elevations.map((v,i)=>({x:p.l+(total?a.distances[i]/total:.5)*gw,
    y:Number.isFinite(v)?p.t+(hi-v)/(hi-lo)*gh:null}));
  for(let first=0;first<points.length;){
    while(first<points.length&&points[first].y===null)first++;
    if(first>=points.length)break;
    let last=first;while(last+1<points.length&&points[last+1].y!==null)last++;
    ctx.beginPath();ctx.moveTo(points[first].x,p.t+gh);
    for(let index=first;index<=last;index++)ctx.lineTo(points[index].x,points[index].y);
    ctx.lineTo(points[last].x,p.t+gh);ctx.fillStyle='#d96c3330';ctx.fill();first=last+1;
  }
  if(a.segments?.length){
    for(const segment of a.segments){
      if(segment.source==='unverified'){
        ctx.beginPath();ctx.moveTo(points[segment.from].x,p.t+gh-6);ctx.lineTo(points[segment.to].x,p.t+gh-6);
        ctx.setLineDash([5,4]);ctx.strokeStyle='#c58b28';ctx.lineWidth=3;ctx.stroke();ctx.setLineDash([]);continue;
      }
      ctx.beginPath();let started=false;
      for(let i=segment.from;i<=segment.to;i++){
        if(points[i].y===null){started=false;continue;}
        if(started)ctx.lineTo(points[i].x,points[i].y);
        else{ctx.moveTo(points[i].x,points[i].y);started=true;}
      }
      ctx.strokeStyle={hrsc:'#4d8b37',mola:'#c36734',ctx:'#aa62b1',hirise:'#3b9cad'}[segment.source]??'#bb532b';ctx.lineWidth=2.5;ctx.stroke();
    }
    for(const segment of a.segments.slice(1)){const point=points[segment.from];ctx.beginPath();ctx.arc(point.x,point.y??p.t+gh-6,3.5,0,Math.PI*2);ctx.fillStyle={hrsc:'#4d8b37',mola:'#c36734',ctx:'#aa62b1',hirise:'#3b9cad',unverified:'#c58b28'}[segment.source]??'#bb532b';ctx.fill();ctx.strokeStyle='#f7f6ef';ctx.lineWidth=1.2;ctx.stroke();}
  }else{ctx.beginPath();points.forEach((point,i)=>i?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.strokeStyle='#bb532b';ctx.lineWidth=2;ctx.stroke();}
  if(points.length===1){ctx.beginPath();ctx.arc(points[0].x,points[0].y,3,0,Math.PI*2);ctx.fillStyle='#bb532b';ctx.fill();}
  ctx.fillStyle='#6a6d61';ctx.textAlign='center';for(let i=0;i<=3;i++)ctx.fillText(`${(total*i/3).toFixed(1)} km`,p.l+gw*i/3,h-5);
}
