import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { decodeTerrain } from '../src/nasa-adapter.js';
import { decodeGlobalRouting, calculateGlobalRoute } from '../src/global-route.js';
import { terrainMeetsDetail } from '../src/accuracy.js';

async function readDataset(id) {
  const metadata = JSON.parse(await readFile(new URL(`../data/${id}.json`, import.meta.url), 'utf8'));
  const bytes = metadata.parts?.length ? Buffer.concat(await Promise.all(metadata.parts.map(async part => {
    const fragment = await readFile(new URL(`../data/${part.file}`, import.meta.url));
    assert.equal(fragment.length, part.bytes);
    assert.equal(createHash('sha256').update(fragment).digest('hex'), part.sha256);
    return fragment;
  }))) : await readFile(new URL(`../data/${id}.bin`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  return [metadata, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)];
}

const datasets = Promise.all([readDataset('mars-global'), readDataset('mars-routing')]).then(([[coarseMeta, coarseBuffer], [fineMeta, fineBuffer]]) => {
  const coarse = decodeTerrain(coarseMeta, coarseBuffer);
  coarse.wrapLongitude = true;
  coarse.risk = null;
  const fine = decodeGlobalRouting(fineMeta, fineBuffer);
  return {coarse, fine};
});

test('verified MOLA 16 px/° data cover the entire planet at an honest 3.7 km spacing', async () => {
  const {fine} = await datasets;
  assert.equal(fine.width, 5760);
  assert.equal(fine.height, 2880);
  assert.deepEqual(fine.bounds, {west:0,east:360,north:90,south:-90});
  assert.equal(terrainMeetsDetail(fine,4000),true);
  assert.equal(terrainMeetsDetail(fine,1000),false);
  assert.ok(fine.elevation.some(value => value < -8000));
  assert.ok(fine.elevation.some(value => value > 20000));
});

test('global routing works away from any special region and across the 0°/360° seam', async () => {
  const {coarse,fine} = await datasets;
  const local = calculateGlobalRoute(coarse,fine,{lat:15.3,lon:131.2},{lat:15.4,lon:132.1},{slopeLimit:12,riskWeight:.6,maxGridSpacingM:4000});
  assert.ok(local.path.length > 2);
  assert.ok(local.analysis.distanceKm > 40 && local.analysis.distanceKm < 70);
  assert.equal(local.quality.source,'Global MOLA 16 px/°');
  const seam = calculateGlobalRoute(coarse,fine,{lat:0,lon:359.4},{lat:.3,lon:.6},{slopeLimit:20,riskWeight:.4,maxGridSpacingM:4000});
  assert.ok(seam.path.length > 2);
  assert.ok(seam.analysis.distanceKm < 100);
  assert.ok(seam.points.some(point => point.lon > 359));
  assert.ok(seam.points.some(point => point.lon < 1));
});

test('a long route uses the same global numeric elevation source', async () => {
  const {coarse,fine} = await datasets;
  const route = calculateGlobalRoute(coarse,fine,{lat:18.6,lon:226.2},{lat:-4.5,lon:137.4},{slopeLimit:20,riskWeight:.4,maxGridSpacingM:4000});
  assert.ok(route.path.length > 1000);
  assert.ok(route.analysis.distanceKm > 5000);
  assert.equal(route.quality.coveragePercent,100);
  assert.throws(() => calculateGlobalRoute(coarse,fine,{lat:0,lon:0},{lat:0,lon:1},{maxGridSpacingM:1000}),/detail/);
});
