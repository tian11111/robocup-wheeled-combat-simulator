#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { calibrate } = require('./sim_calibrate');

function close(actual, expected, tolerance, label){
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected}, got ${actual}`);
}
function lateralFrames(k, start, count, dt){
  let y = 0;
  const frames = [{ t: 0, robot: { x: 0, y, th: 0 }, command: { v: 0, w: 0 } }];
  for (let index = 0; index < count; index++){
    y += start * Math.exp(-k * index * dt) * dt;
    frames.push({ t: (index + 1) * dt, robot: { x: 0, y, th: 0 }, command: { v: 0, w: 0 } });
  }
  return frames;
}
function angularFrames(k, start, count, dt){
  let th = 0;
  const frames = [{ t: 0, robot: { x: 0, y: 0, th }, command: { v: 0, w: 0 } }];
  for (let index = 0; index < count; index++){
    th += start * Math.exp(-k * index * dt) * dt;
    frames.push({ t: (index + 1) * dt, robot: { x: 0, y: 0, th }, command: { v: 0, w: 0 } });
  }
  return frames;
}
function blockFrames(mu, start, count, dt){
  let x = 0;
  let speed = start;
  const frames = [{ t: 0, block: { x, y: 0 } }];
  for (let index = 0; index < count; index++){
    x += speed * dt;
    frames.push({ t: (index + 1) * dt, block: { x, y: 0 } });
    speed = Math.max(0, speed * Math.exp(-2.2 * dt) - mu * 9.81 * dt);
  }
  return frames;
}

const result = calibrate({
  schemaVersion: 1,
  vehicle: { id: 'selftest-bot' },
  trials: [
    { id: 'lateral', kind: 'lateral_coast', frames: lateralFrames(8, 1, 8, 0.05) },
    { id: 'spin', kind: 'angular_coast', frames: angularFrames(3, 2, 8, 0.05) },
    { id: 'block', kind: 'block_push', frames: blockFrames(0.45, 2, 9, 0.05) },
    { id: 'wall-1', kind: 'collision', normal: { x: 1, y: 0 }, impact: { pre: { robot: { vx: 1, vy: 0 } }, post: { robot: { vx: -0.33, vy: 0 } } } },
    { id: 'wall-2', kind: 'collision', normal: { x: 1, y: 0 }, impact: { pre: { robot: { vx: 0.8, vy: 0 } }, post: { robot: { vx: -0.264, vy: 0 } } } },
    { id: 'wall-3', kind: 'collision', normal: { x: 1, y: 0 }, impact: { pre: { robot: { vx: 1.2, vy: 0 } }, post: { robot: { vx: -0.396, vy: 0 } } } },
    { id: 'stall', kind: 'stall', frames: [
      { t: 0.0, robot: { speed: 0.010 }, command: { v: 0.6 }, stalled: true },
      { t: 0.1, robot: { speed: 0.020 }, command: { v: 0.6 }, stalled: true },
      { t: 0.2, robot: { speed: 0.025 }, command: { v: 0.6 }, stalled: true },
      { t: 0.3, robot: { speed: 0.070 }, command: { v: 0.6 }, stalled: false },
      { t: 0.4, robot: { speed: 0.090 }, command: { v: 0.6 }, stalled: false },
      { t: 0.5, robot: { speed: 0.120 }, command: { v: 0.6 }, stalled: false },
    ] },
    { id: 'mount-evidence', kind: 'mount', frames: [{ t: 0, robot: { x: 1, y: 0.4, th: 0 } }, { t: 0.1, robot: { x: 1, y: 0.5, th: 0 } }] },
  ],
});

assert.ok(result.fits.latFrictionK.calibrated);
assert.ok(result.fits.angDamping.calibrated);
assert.ok(result.fits.BLOCK_MU_K.calibrated);
assert.ok(result.fits.COLLISION_RESTITUTION.calibrated);
assert.ok(result.fits.STALL_SPEED.calibrated);
close(result.fits.latFrictionK.value, 8, 0.01, 'latFrictionK');
close(result.fits.angDamping.value, 3, 0.01, 'angDamping');
close(result.fits.BLOCK_MU_K.value, 0.45, 0.01, 'BLOCK_MU_K');
close(result.fits.COLLISION_RESTITUTION.value, 0.33, 0.001, 'COLLISION_RESTITUTION');
assert.ok(result.fits.STALL_SPEED.value >= 0.025 && result.fits.STALL_SPEED.value < 0.07);
assert.deepStrictEqual(result.fidelityEligible, { friction: true, collision: true, stall: true, mount: false });
console.log('sim_calibrate_selftest: 通过');
