import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {catalogBboxes,fetchAreaFootprints,pointInGeometry} from '../src/area-catalog.js';
import {TerrainMap} from '../src/map-view.js';

test('DTM footprint searches split the 180° seam into valid STAC longitudes',()=>{
  assert.deepEqual(catalogBboxes({west:170,east:190,south:4,north:5}),
    [[170,4,180,5],[-180,4,-170,5]]);
});

test('CTX and HiRISE area searches return real catalogue geometries and report incomplete pages',async()=>{
  const requests=[];
  const fetcher=async url=>{
    requests.push(new URL(url));
    return {ok:true,json:async()=>({numberMatched:501,features:[{
      id:'model-1',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]},properties:{gsd:20}
    },...Array.from({length:499},(_,index)=>({id:`model-${index+2}`,geometry:{type:'Polygon',coordinates:[]},properties:{gsd:20}}))]})};
  };
  const result=await fetchAreaFootprints('ctx',{west:1,east:2,south:3,north:4},{fetcher});
  assert.equal(requests.length,1);
  assert.equal(requests[0].searchParams.get('collections'),'mro_ctx_controlled_usgs_dtms');
  assert.equal(result.features.length,500);
  assert.equal(result.features[0].gsd,20);
  assert.equal(result.truncated,true);
});

test('CTX footprint search reads all catalogue pages before switching away from the overview',async()=>{
  const requests=[];
  const feature=id=>({id,geometry:{type:'Polygon',coordinates:[]},properties:{gsd:20}});
  const fetcher=async url=>{
    requests.push(new URL(url));
    const next=url.searchParams.get('next');
    return {ok:true,json:async()=>next?
      {numberMatched:501,features:[feature('last')],links:[]}:
      {numberMatched:501,features:Array.from({length:500},(_,index)=>feature(`first-${index}`)),
        links:[{rel:'next',href:'https://example.com/search?next=page-2'}]}};
  };
  const result=await fetchAreaFootprints('ctx',{west:1,east:2,south:3,north:4},{fetcher});
  assert.equal(requests.length,2);
  assert.equal(requests[1].searchParams.get('next'),'page-2');
  assert.equal(result.features.length,501);
  assert.equal(result.truncated,false);
});

test('catalogue hit test respects polygon holes',()=>{
  const geometry={type:'Polygon',coordinates:[
    [[0,0],[4,0],[4,4],[0,4],[0,0]],
    [[1,1],[2,1],[2,2],[1,2],[1,1]]
  ]};
  assert.equal(pointInGeometry(.5,.5,geometry),true);
  assert.equal(pointInGeometry(1.5,1.5,geometry),false);
  assert.equal(pointInGeometry(5,5,geometry),false);
});

test('global CTX and HiRISE previews include the complete catalogued product counts',()=>{
  const metadata=JSON.parse(readFileSync(new URL('../data/area-overview.json',import.meta.url)));
  assert.equal(metadata.width,5280);
  assert.equal(metadata.height,2616);
  for(const [source,minimum] of [['ctx',44000],['hirise',1200]]){
    const entry=metadata.sources[source];
    assert.ok(entry.products>=minimum,`${source} preview has too few catalogue products`);
    const bytes=readFileSync(new URL(`../data/area-${source}.png`,import.meta.url));
    assert.equal(bytes.toString('ascii',1,4),'PNG');
    assert.equal(bytes.readUInt32BE(16),metadata.width);
    assert.equal(bytes.readUInt32BE(20),metadata.height);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.pngSha256);
  }
});

test('planet-scale DTM preview keeps the same 0–360° longitude as exact contours',()=>{
  const image={width:360,height:180},calls=[];
  const map=Object.create(TerrainMap.prototype);
  map.coverageFilter='ctx';map.camera={frame:{x:10,y:20,w:720,h:360}};
  map.areaCatalog={ctx:null};map.areaOverview={ctx:{state:'ready',image}};
  const ctx={save(){},beginPath(){},rect(){},clip(){},restore(){},drawImage(...args){calls.push(args)}};
  map.drawAreaOverview(ctx,{west:0,east:360,south:-90,north:90});
  assert.deepEqual(calls,[[image,0,0,360,180,10,20,720,360]]);
  calls.length=0;
  map.drawAreaOverview(ctx,{west:140,east:160,south:-20,north:-10});
  assert.equal(calls.length,1,'the overview must stay visible while the close-view catalogue is incomplete');
  map.areaCatalog.ctx={bounds:{west:139,east:161,south:-21,north:-9},features:[],truncated:false};
  calls.length=0;
  map.drawAreaOverview(ctx,{west:140,east:160,south:-20,north:-10});
  assert.equal(calls.length,0,'the complete close-view catalogue replaces the overview');
});
