import test from 'node:test';
import assert from 'node:assert/strict';
import {edgeHitsHazard,rebuildRouteQuality} from '../src/hazard-routing.js';
import {selectSurveyTiles,tileForCoordinate,surveyRouteImages} from '../src/image-coverage.js';

test('terrain depression clearance checks the whole edge between route points',()=>{
  const hazard={lat:0,lon:10,radiusM:20,contourErrorM:2,score:.95,source:'ctx'};
  const points=[{lat:0,lon:9.999,source:'mola',spacingM:200},
    {lat:0,lon:10.001,source:'mola',spacingM:200}];
  const settings={vehicleRadiusM:1};
  assert.equal(edgeHitsHazard(points[0],points[1],hazard,settings),true);
  assert.equal(edgeHitsHazard(points[0],points[0],hazard,settings),false);
});

test('image survey tiles remain adjacent across 0°/360° longitude',()=>{
  const west=tileForCoordinate({lat:0,lon:359.99},13),east=tileForCoordinate({lat:0,lon:.01},13);
  assert.equal(west.zoom,13);assert.equal(east.zoom,13);
  assert.equal(east.col-west.col,1);
  const selection=selectSurveyTiles([{lat:0,lon:359.99},{lat:0,lon:.01}],32);
  assert.equal(selection.zoom,12);
  assert.equal(selection.tiles.length,2);
});

test('a source-guide color change in one blend DEM keeps physical ascent and slope',()=>{
  const points=[{lat:0,lon:10,source:'hrsc'},{lat:0,lon:10.003374,source:'mola'}];
  const result=rebuildRouteQuality(points,[0,100]);
  assert.equal(result.analysis.elevationGain,100);
  assert.ok(result.analysis.maxSlope>25);
});

test('image survey covers tiles between widely spaced route vertices',()=>{
  const selection=selectSurveyTiles([{lat:0,lon:10},{lat:0,lon:20}],32);
  assert.ok(selection.tiles.length>2);
  assert.equal(selection.truncated,false);
  assert.ok(selection.points.length>selection.tiles.length);
});

test('image survey reads CTX and HiRISE together for each tile',async()=>{
  let active=0,peak=0;
  const image={width:512,height:512,data:new Uint8ClampedArray(512*512*4)};
  const result=await surveyRouteImages([{lat:.01,lon:10.01},{lat:.0101,lon:10.0101}],{
    readTileImage:async()=>{
      peak=Math.max(peak,++active);
      await new Promise(resolve=>setTimeout(resolve,5));
      active--;
      return image;
    }
  });
  assert.equal(peak,2);
  assert.equal(result.failed,1);
});

test('strict image coverage detects a narrow missing stripe along the route',async()=>{
  const tile=tileForCoordinate({lat:.01,lon:10.01},12),span=180/2**12;
  const west=-180+tile.col*span,north=90-tile.row*span;
  const points=[100,400].map(x=>({lat:north-span/2,lon:west+x/512*span}));
  const data=new Uint8ClampedArray(512*512*4);
  for(let y=0;y<512;y++)for(let x=0;x<512;x++)data[(y*512+x)*4+3]=x===250?0:255;
  const image={width:512,height:512,data};
  const result=await surveyRouteImages(points,{strictCoverage:true,
    readTileImage:async()=>image});
  assert.equal(result.truncated,false);
  assert.ok(result.inspectedBySourceKm.hirise<result.totalKm);
});

test('a join between independent DEMs is marked unverified and excluded from slope',()=>{
  const points=[{lat:0,lon:10,source:'mola'},
    {lat:0,lon:10.001,source:'ctx',modelId:'stereo-1'},
    {lat:0,lon:10.002,source:'ctx',modelId:'stereo-1'}];
  const result=rebuildRouteQuality(points,[0,100,101]);
  assert.ok(result.unverifiedJoinKm>0);
  assert.equal(result.segments[0].source,'unverified');
  assert.equal(result.analysis.elevationGain,1);
});
