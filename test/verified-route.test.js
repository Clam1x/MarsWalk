import test from 'node:test';
import assert from 'node:assert/strict';
import {assessVerifiedRoute} from '../src/verified-route.js';
import {modelOrthoAvailable,decodeElevationSamples,discoverLocalModels} from '../src/local-dtm.js';

const route={points:[{source:'hirise',modelId:'one'},{source:'hirise',modelId:'one'}],spacingM:1,
  unverifiedKm:0,unresolved:[],evidence:{status:'checked',reasons:[]}};
const survey={totalKm:1,inspectedKm:1,inspectedBySourceKm:{hirise:1},imagePixelM:1,failed:0,truncated:false};

test('fully checked route requires continuous detailed heights and complete imagery',()=>{
  assert.equal(assessVerifiedRoute(route,survey).ok,true);
  assert.equal(assessVerifiedRoute({...route,unverifiedKm:.01},survey).ok,false);
  assert.equal(assessVerifiedRoute({...route,points:[route.points[0],{source:'ctx',modelId:'two'}]},survey).ok,false);
  assert.equal(assessVerifiedRoute(route,{...survey,inspectedBySourceKm:{hirise:.8}}).ok,false);
  assert.equal(assessVerifiedRoute(route,{...survey,truncated:true}).ok,false);
  assert.equal(assessVerifiedRoute(route,{...survey,imagePixelM:5}).ok,false);
  assert.equal(assessVerifiedRoute({...route,unresolved:[{}]},survey).ok,false);
  assert.equal(assessVerifiedRoute({...route,evidence:{status:'uncertain',reasons:['image–terrain agreement unmeasured']}},survey).ok,false);
});

test('strict route requires a reachable matched orthoimage',async()=>{
  const model={qualityAssets:{ortho:'https://astrogeo-ard.s3-us-west-2.amazonaws.com/example.tif'}};
  assert.equal(await modelOrthoAvailable(model,{fetcher:async()=>({ok:true})}),true);
  assert.equal(await modelOrthoAvailable(model,{fetcher:async()=>({ok:false})}),false);
  assert.equal(await modelOrthoAvailable({qualityAssets:{ortho:'https://example.com/image.tif'}},
    {fetcher:async()=>({ok:true})}),false);
});

test('DTM decoder preserves valid zero height and applies supplied elevation scaling',()=>{
  const raw=new Int16Array([0,20,-32767]);
  assert.equal(decodeElevationSamples(raw,null).noData.toString(),'NaN');
  assert.equal(decodeElevationSamples(raw,null).elevation[0],0);
  const decoded=decodeElevationSamples(raw,-32767,{SCALE:0.5,OFFSET:-100});
  assert.deepEqual([...decoded.elevation].slice(0,2),[-100,-90]);
  assert.equal(Number.isNaN(decoded.elevation[2]),true);
});

test('strict catalogue lookup does not silently accept an incomplete result page',async()=>{
  const fetcher=async()=>({ok:true,json:async()=>({features:Array(100).fill({})})});
  await assert.rejects(discoverLocalModels({lat:0,lon:10},{lat:.01,lon:10.01},
    {fetcher,requireComplete:true}),/incomplete/);
});

test('strict catalogue follows a real next-page token and recognizes HiRISE ortho assets',async()=>{
  const assetRoot='https://astrogeo-ard.s3-us-west-2.amazonaws.com/example/';
  const feature={id:'jezero-model',geometry:{type:'Polygon',coordinates:[[[9,-1],[11,-1],[11,1],[9,1],[9,-1]]]},
    properties:{gsd:1,'proj:wkt2':'Equirectangular'},assets:{dtm:{href:assetRoot+'dtm.tif'},
      ortho_0:{href:assetRoot+'matched_ORTHO.tif'},ortho_thumbnail_0:{href:assetRoot+'thumb.jpg'},
      fom:{href:assetRoot+'fom.tif'},provenance:{href:assetRoot+'provenance.txt'}}};
  const calls=[];
  const fetcher=async url=>{
    calls.push(url.toString());
    const hirise=url.searchParams.get('collections')==='mro_hirise_socet_dtms';
    return {ok:true,json:async()=>hirise&&!url.searchParams.has('next')?
      {features:[feature],links:[{rel:'next',href:'https://example.com/search?next=cursor-1'}]}:
      {features:[],links:[]}};
  };
  const models=await discoverLocalModels({lat:0,lon:10},{lat:.01,lon:10.01},
    {fetcher,requireComplete:true});
  assert.equal(models.length,1);
  assert.equal(models[0].qualityAssets.ortho,assetRoot+'matched_ORTHO.tif');
  assert.equal(models[0].qualityAssets.figureOfMerit,assetRoot+'fom.tif');
  assert.ok(calls.some(url=>url.includes('next=cursor-1')));
});
