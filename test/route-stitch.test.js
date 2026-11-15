import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverLocalModels,discoverRouteModels,localRoutePatches} from '../src/local-dtm.js';
import {stitchLocalPatches} from '../src/route-stitch.js';

test('route-line catalogue search finds a local model even when endpoints are outside it',async()=>{
  let requested;
  const fetcher=async url=>{
    requested=new URL(url);
    return {ok:true,json:async()=>({features:[{
      id:'regional-ctx',collection:'mro_ctx_controlled_usgs_dtms',properties:{gsd:20,'proj:wkt2':'Equirectangular'},
      assets:{dtm:{href:'https://astrogeo-ard.s3-us-west-2.amazonaws.com/example.tif'}},
      geometry:{type:'Polygon',coordinates:[[[.01,-.01],[.03,-.01],[.03,.01],[.01,.01],[.01,-.01]]]}
    }]})};
  };
  const models=await discoverRouteModels([{lat:0,lon:0},{lat:0,lon:.02},{lat:0,lon:.04}],{fetcher});
  assert.equal(models.length,1);
  assert.equal(models[0].source,'ctx');
  assert.equal(models[0].url,'https://astrogeo-ard.s3-us-west-2.amazonaws.com/example.tif');
  assert.equal(JSON.parse(requested.searchParams.get('intersects')).type,'LineString');
});

test('CTX DTM asset is accepted when both route endpoints lie in one model',async()=>{
  const feature={id:'ctx-model',collection:'mro_ctx_controlled_usgs_dtms',
    properties:{gsd:20,'proj:wkt2':'Equirectangular'},
    assets:{dtm:{href:'https://astrogeo-ard.s3-us-west-2.amazonaws.com/ctx-dtm.tif'}},
    geometry:{type:'Polygon',coordinates:[[[44,1],[45,1],[45,2],[44,2],[44,1]]]}};
  const fetcher=async url=>({ok:true,json:async()=>({features:url.searchParams.get('collections')==='mro_ctx_controlled_usgs_dtms'?[feature]:[]})});
  const models=await discoverLocalModels({lat:1.5,lon:44.2},{lat:1.6,lon:44.8},{fetcher});
  assert.equal(models.length,1);
  assert.equal(models[0].url,feature.assets.dtm.href);
});

test('local patch search retries shorter ranges after a native-grid budget limit',async()=>{
  const feature={id:'ctx-model',collection:'mro_ctx_controlled_usgs_dtms',
    properties:{gsd:20,'proj:wkt2':'Equirectangular'},
    assets:{dtm:{href:'https://astrogeo-ard.s3-us-west-2.amazonaws.com/ctx-dtm.tif'}},
    geometry:{type:'Polygon',coordinates:[[[-.01,-.01],[.07,-.01],[.07,.01],[-.01,.01],[-.01,-.01]]]}};
  const fetcher=async()=>({ok:true,json:async()=>({features:[feature]})});
  const points=Array.from({length:7},(_,index)=>({lat:0,lon:index*.01}));
  const routeForModel=async(_model,start,goal)=>{
    if(goal.lon-start.lon>.025)throw new Error('Native DTM search budget exceeded');
    return {points:[start,goal]};
  };
  const patches=await localRoutePatches(points,{}, {fetcher,routeForModel});
  assert.ok(patches.length>0);
  assert.ok(patches.some(patch=>patch.to-patch.from>=2));
  assert.match(patches.searchNote,/search budget/);
});

test('local patch creates visible source transitions without counting registration jumps as slope',()=>{
  const base={points:[0,.01,.02,.03,.04].map(lon=>({lat:0,lon,source:'mola'})),
    analysis:{elevations:[0,1,2,3,4]},loadedCells:50,explored:10,spacingM:200};
  const route={points:[.01,.02,.03].map(lon=>({lat:0,lon,source:'ctx'})),
    analysis:{elevations:[100,101,102]},loadedCells:30,explored:5,spacingM:20,footprint:{type:'Polygon',coordinates:[]}};
  const result=stitchLocalPatches(base,[{from:1,to:3,route,model:{source:'ctx',id:'regional-ctx'}}]);
  assert.deepEqual(result.segments.map(item=>item.source),['ctx','mola']);
  assert.equal(result.localModels[0].spacingM,20);
  assert.equal(result.transitions.length,1);
  assert.equal(result.elevations,undefined);
  assert.equal(result.analysis.elevationGain,2);
  assert.ok(result.analysis.maxSlope<1);
  assert.equal(result.analysis.elevations.length,result.points.length);
});
