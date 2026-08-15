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
  const r = await fetch(base + path, options);
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(body)}`);
  return body;
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
