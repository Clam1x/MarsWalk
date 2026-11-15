import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRoute, findRoute } from "../src/astar.js";

function flatTerrain(width, height) {
  return { width, height, elevation: new Float32Array(width * height), risk: new Float32Array(width * height), cellKm: 0.1 };
}

test("A* finds a diagonal route across flat terrain", () => {
  const terrain = flatTerrain(5, 5);
  const result = findRoute(terrain, 0, 24);
  assert.deepEqual(result.path, [0, 6, 12, 18, 24]);
  assert.ok(result.explored > 0);
});

test("A* returns the start when start equals goal", () => {
  const result = findRoute(flatTerrain(3, 3), 4, 4);
  assert.deepEqual(result.path, [4]);
  assert.equal(result.cost, 0);
});

test("A* avoids high-risk cells when avoidance is enabled", () => {
  const terrain = flatTerrain(5, 3);
  terrain.risk[7] = 1;
  const result = findRoute(terrain, 5, 9, { riskWeight: 1 });
  assert.ok(!result.path.includes(7));
});

test("route analysis calculates distance, gain and samples", () => {
  const terrain = flatTerrain(3, 2);
  terrain.elevation.set([0, 10, 20, 0, 0, 0]);
  const analysis = analyzeRoute(terrain, [0, 1, 2]);
  assert.equal(analysis.distanceKm, 0.2);
  assert.equal(analysis.elevationGain, 20);
  assert.equal(analysis.elevations.length, 3);
  assert.ok(analysis.maxSlope > 0);
});

test('the final edge cannot bypass the slope limit', () => {
  const t=flatTerrain(2,1);t.elevation[1]=1000;
  assert.deepEqual(findRoute(t,0,1,{slopeLimit:10}).path,[]);
});
test('no-data and diagonal corner crossings are blocked', () => {
  const t=flatTerrain(2,2);t.elevation[1]=NaN;t.elevation[2]=NaN;
  assert.deepEqual(findRoute(t,0,3).path,[]);
  assert.deepEqual(findRoute(t,1,1).path,[]);
  assert.deepEqual(findRoute(t,-1,3).path,[]);
});
