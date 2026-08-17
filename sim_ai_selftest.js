#!/usr/bin/env node
/*
 * sim_ai_selftest.js — 本机 AI API 冒烟测试
 * 启动临时 sim_server，检查 health/schema 和一组 FSM 多 seed 评测。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const port = 8947;
const base = `http://127.0.0.1:${port}`;
let child;
let candidateFile;

async function request(path, options){
  const result = await requestRaw(path, options);
  if (result.status < 200 || result.status >= 300) throw new Error(`${result.status} ${path}: ${JSON.stringify(result.body)}`);
  return result.body;
}
async function requestRaw(path, options){
  const r = await fetch(base + path, options);
  const body = await r.json();
  return { status: r.status, body };
}
async function waitHealth(timeoutMs=10000){
  const end = Date.now() + timeoutMs;
  while (Date.now() < end){
    try { return await request('/api/v1/health'); } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('等待 sim_server health 超时');
}

(async () => {
  child = spawn(process.execPath, ['sim_server.js', String(port)], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const health = await waitHealth();
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.apiVersion, 'v1');
  assert.ok(health.coreHash);

  const schema = await request('/api/v1/schema');
  assert.deepStrictEqual(schema.deterministic.fixedSeedSet, [42, 7, 21, 100, 123]);
  assert.ok(schema.evaluation && schema.evaluation.endpoint);

  const placed = await request('/scene', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      us: { x: 1.1, y: 1.2, th: 0.3 }, them: { x: 2.7, y: 2.6, th: -0.4 },
      vehicles: { us: { maxSpeed: 0.9 }, them: { maxSpeed: 1.1 } },
    }),
  });
  assert.strictEqual(placed.state.robots.us.x, 1.1);
  assert.strictEqual(placed.state.robots.us.th, 0.3);
  assert.strictEqual(placed.state.robots.them.y, 2.6);
  assert.strictEqual(placed.state.robots.them.th, -0.4);
  assert.strictEqual(placed.state.robots.us.vehicle.maxSpeed, 0.9);
  assert.strictEqual(placed.state.robots.them.vehicle.maxSpeed, 1.1);

  const started = await request('/api/v1/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ us: 'fsm', them: 'fsm', seeds: [42, 7], includeTrace: true, traceEvery: 40 }),
  });
  assert.strictEqual(started.ok, true);
  assert.ok(started.id);

  let result;
  for (let i = 0; i < 200; i++){
    result = await request('/api/v1/evaluations/' + encodeURIComponent(started.id));
    if (['done', 'error', 'cancelled'].includes(result.status)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.strictEqual(result.status, 'done');
  assert.strictEqual(result.summary.count, 2);
  assert.strictEqual(result.runs.length, 2);
  assert.ok(typeof result.summary.meanNetScore === 'number');
  assert.ok(result.runs[0].metrics && result.runs[0].trace);
  assert.strictEqual(result.runs[0].traceFormat, 'diagnostic-v1');
  assert.strictEqual(result.runs[0].diagnostics.format, 'diagnostic-v1');
  assert.ok(result.runs[0].trace[1].us.actions);
  assert.ok(result.runs[0].trace[1].us.rawSensors);
  assert.ok(Array.isArray(result.runs[0].events));

  const candidate = await request('/api/v1/evaluations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate: {
        name: 'api_smoke',
        role: 'us',
        code: "def decide(obs):\n    return {'v': 0.0, 'w': 0.0}\n",
      },
      them: 'fsm', seeds: [42], maxSteps: 12,
    }),
  });
  assert.strictEqual(candidate.ok, true);
  assert.ok(candidate.candidate && candidate.candidate.file);
  candidateFile = candidate.candidate.file;
  let candidateResult;
  for (let i = 0; i < 200; i++){
    candidateResult = await request('/api/v1/evaluations/' + encodeURIComponent(candidate.id));
    if (['done', 'error', 'cancelled'].includes(candidateResult.status)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.strictEqual(candidateResult.status, 'done');
  assert.strictEqual(candidateResult.summary.count, 1);

  const battle = await request('/battle/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ us: 'fsm', them: 'fsm', seed: 42, maxSteps: 2400 }),
  });
  assert.strictEqual(battle.ok, true);
  assert.ok(battle.controlToken);
  for (const [endpoint, body] of [
    ['/step', { dt: 0.05 }], ['/step2', { dt: 0.05 }], ['/params', { EDGE_THRESHOLD: 301 }], ['/scene', { preset: 'center' }],
  ]) {
    const denied = await requestRaw(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.strictEqual(denied.status, 409, `${endpoint} 必须在后台对战期间被互斥锁拒绝`);
  }
  const controlled = await request('/battle/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: battle.controlToken, command: 'scene', scene: { us: { x: 1.3, y: 1.4, th: 0.2 }, them: { x: 2.5, y: 2.4, th: -0.2 } } }),
  });
  assert.strictEqual(controlled.state.robots.us.x, 1.3);
  assert.strictEqual(controlled.state.robots.them.th, -0.2);
  assert.strictEqual((await request('/battle/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: battle.controlToken, command: 'params', params: { EDGE_THRESHOLD: 302 } }),
  })).command, 'params');
  assert.strictEqual((await request('/battle/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: battle.controlToken, command: 'pause', reason: 'test' }),
  })).command, 'pause');
  assert.strictEqual((await request('/battle/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: battle.controlToken, command: 'resume' }),
  })).command, 'resume');
  await request('/battle/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  let status;
  for (let i = 0; i < 100; i++){
    status = await request('/battle/status');
    if (!status.running) break;
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(status && !status.running, '后台对战应在 stop 后释放单例核心');
  console.log('AI API 自测通过 ✔');
  console.log(`  coreHash=${health.coreHash} | fsmRuns=${result.summary.count} | candidateRuns=${candidateResult.summary.count}`);
})().catch(e => {
  console.error('AI API 自测失败:', e.message || e);
  process.exitCode = 1;
}).finally(() => {
  if (candidateFile){
    try { fs.unlinkSync(path.join(__dirname, candidateFile)); } catch (e) {}
  }
  if (child) child.kill();
});
