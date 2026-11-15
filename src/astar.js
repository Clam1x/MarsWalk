import { elevationAtNode, terrainDistanceKm, terrainSlopeDegrees, traversable } from "./terrain.js";
import { terrainMeetsDetail } from './accuracy.js';

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) return undefined;
    const root = this.items[0];
    const tail = this.items.pop();
    if (this.items.length && tail) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].priority < this.items[left].priority ? right : left;
        if (this.items[child].priority >= tail.priority) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = tail;
    }
    return root;
  }
  get size() { return this.items.length; }
}

const directions = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],   [1, 1]
];

export function findRoute(terrain, start, goal, options = {}) {
  const slopeLimit = options.slopeLimit ?? 24;
  const riskWeight = options.riskWeight ?? 0.6;
  if (!Number.isFinite(slopeLimit) || slopeLimit <= 0 || !Number.isFinite(riskWeight) || riskWeight < 0) throw new Error('Invalid routing options');
  if (options.maxGridSpacingM !== undefined && !terrainMeetsDetail(terrain, options.maxGridSpacingM)) throw new Error('Elevation grid does not meet the requested detail');
  const allowed = options.allowed ?? (() => true);
  const edgeAllowed = options.edgeAllowed ?? (() => true);
  const nodePenalty = options.nodePenalty ?? (() => 0);
  if (!traversable(terrain, start) || !traversable(terrain, goal) || !allowed(start) || !allowed(goal)) return { path: [], explored: 0, cost: Infinity };
  const estimate = (a, b) => terrainDistanceKm(terrain, a, b) / terrain.cellKm;
  if (start === goal) return { path: [start], explored: 1, cost: 0 };

  const count = terrain.width * terrain.height;
  const sparse = !!terrain.sparse;
  const scores = sparse ? new Map() : count > 2e6 ? new Float32Array(count) : new Float64Array(count);
  if (!sparse) scores.fill(Infinity);
  const getScore = node => sparse ? (scores.get(node) ?? Infinity) : scores[node];
  const setScore = (node, value) => sparse ? scores.set(node, value) : (scores[node] = value);
  setScore(start, 0);
  const cameFrom = sparse ? new Map() : new Int32Array(count);
  if (!sparse) cameFrom.fill(-1);
  const getPrevious = node => sparse ? (cameFrom.get(node) ?? -1) : cameFrom[node];
  const setPrevious = (node, previous) => sparse ? cameFrom.set(node, previous) : (cameFrom[node] = previous);
  const closed = sparse ? new Set() : new Uint8Array(count);
  const isClosed = node => sparse ? closed.has(node) : !!closed[node];
  const close = node => sparse ? closed.add(node) : (closed[node] = 1);
  const queue = new MinHeap();
  queue.push({ node: start, priority: estimate(start, goal) });
  let explored = 0;

  while (queue.size) {
    const current = queue.pop().node;
    if (isClosed(current)) continue;
    close(current);
    explored += 1;
    if (current === goal) {
      const path = [];
      let cursor = goal;
      while (cursor !== -1) {
        path.push(cursor);
        cursor = getPrevious(cursor);
      }
      return { path: path.reverse(), explored, cost: getScore(goal) };
    }

    const cx = current % terrain.width;
    const cy = Math.floor(current / terrain.width);
    for (const [dx, dy] of directions) {
      const nx = terrain.wrapLongitude ? (cx + dx + terrain.width) % terrain.width : cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= terrain.width || ny >= terrain.height) continue;
      const next = ny * terrain.width + nx;
      if (isClosed(next) || !traversable(terrain, next) || !allowed(next) || !edgeAllowed(current,next)) continue;
      const slope = terrainSlopeDegrees(terrain, current, next);
      if (slope > slopeLimit) continue;
      if (dx && dy) {
        const sides = [cy * terrain.width + nx, ny * terrain.width + cx];
        if (sides.some(side => !traversable(terrain, side) || !allowed(side) || terrainSlopeDegrees(terrain, current, side) > slopeLimit || terrainSlopeDegrees(terrain, side, next) > slopeLimit)) continue;
      }
      const stepCost = estimate(current, next);
      const slopePenalty = stepCost * (slope / Math.max(1, slopeLimit)) ** 2 * 3;
      const riskPenalty = stepCost * (terrain.risk?.[next] ?? Math.min(1, slope / 30)) * riskWeight * 8;
      const tentative = getScore(current) + stepCost + slopePenalty + riskPenalty + Math.max(0,nodePenalty(next,current,stepCost));
      if (tentative < getScore(next)) {
        setPrevious(next, current);
        setScore(next, tentative);
        queue.push({ node: next, priority: tentative + estimate(next, goal) });
      }
    }
  }
  return { path: [], explored, cost: Infinity };
}

export function analyzeRoute(terrain, path) {
  if (!path.length) return { distanceKm: 0, elevationGain: 0, maxSlope: 0, elevations: [], distances: [] };
  let distanceKm = 0;
  let elevationGain = 0;
  let maxSlope = 0;
  const elevations = [elevationAtNode(terrain, path[0])];
  const distances = [0];
  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    distanceKm += terrainDistanceKm(terrain, previous, current);
    const rise = elevationAtNode(terrain, current) - elevationAtNode(terrain, previous);
    if (rise > 0) elevationGain += rise;
    maxSlope = Math.max(maxSlope, terrainSlopeDegrees(terrain, previous, current));
    elevations.push(elevationAtNode(terrain, current));
    distances.push(distanceKm);
  }
  return { distanceKm, elevationGain, maxSlope, elevations, distances };
}
