import test from 'node:test';
import assert from 'node:assert/strict';
import { niceScaleBar } from '../src/scale.js';

test('scale bar uses a round distance with a matching physical width', () => {
  const bar=niceScaleBar(19.3);
  assert.equal(bar.label,'≈20 km');
  assert.ok(bar.widthPx>80&&bar.widthPx<90);
  assert.ok(Math.abs(bar.widthPx/80*19.3-bar.distanceKm)<1e-9);
});

test('scale bar uses metres on close zoom and stays readable', () => {
  const bar=niceScaleBar(.42);
  assert.equal(bar.label,'≈500 m');
  assert.ok(bar.widthPx>=55&&bar.widthPx<=150);
});
