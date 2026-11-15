import test from 'node:test';
import assert from 'node:assert/strict';
import {planEVA} from '../src/eva-plan.js';

test('science stops, return leg and reserve-adjusted time budgets',()=>{
  const plan=planEVA({distanceKm:6,speedKmh:2,returnToStart:true,
    stops:[{distanceKm:4,minutes:30},{distanceKm:2,minutes:60}],
    budgets:{oxygen:10,power:8,water:'',limit:9},reservePercent:20});
  assert.equal(plan.walkHours,3);
  assert.equal(plan.workHours,1.5);
  assert.equal(plan.totalHours,7.5);
  assert.deepEqual(plan.itinerary.map(stop=>stop.arrivalHours),[1,3]);
  assert.equal(plan.resources.oxygen.status,'within');
  assert.equal(plan.resources.power.status,'over');
  assert.equal(plan.resources.water.status,'unknown');
  assert.equal(plan.resources.limit.status,'over');
});

test('one way plan and invalid inputs',()=>{
  const base={distanceKm:4,speedKmh:2,returnToStart:false,stops:[],budgets:{oxygen:null},reservePercent:20};
  assert.equal(planEVA(base).totalHours,2);
  assert.equal(planEVA(base).returnHours,0);
  assert.throws(()=>planEVA({...base,speedKmh:0}),RangeError);
  assert.throws(()=>planEVA({...base,stops:[{distanceKm:5,minutes:10}]}),RangeError);
});
