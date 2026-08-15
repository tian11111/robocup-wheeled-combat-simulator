#!/usr/bin/env node
/* ============================================================
 * sim_server.js — 无头 HTTP API 服务器
 * 供 AI Agent (Codex / ZCode) 链接仿真器迭代决策算法;
 * 支持把用户自己的小车程序作为子进程接入对战(/battle/run)。
 *
 * 启动: node sim_server.js [port]     (默认 8932)
 *
 * 端点:
 *   GET   /               → 服务信息
 *   POST  /reset          → {seed?, params?, scene?, vehicles?, manual?}  重置(可复现)
 *   POST  /arm            → 发令 (FSM 模式, 双车)
 *   POST  /step           → {dt?, action?{v,w}?}  单步推进(旧接口: action 控制我方)
 *   POST  /step2          → {dt?, us?{v,w}?, them?{v,w}?}  分别控制两车
 *   POST  /params         → 改参数(实时生效)
 *   GET   /vehicle?role=us|them → 读取一台车的 profile
 *   POST  /vehicle        → {role, vehicle:{...}}  修改一台车的 profile
 *   POST  /scene          → 摆场景: {preset} 或 {robot:{x,y,th}, opp:{x,y}, buffs, debuff}
 *   POST  /battle/run     → {us?:'fsm'|命令, them?:'fsm'|命令, vehicles?, seed?, dt?, maxSteps?}
 *                            跑一整场(可子进程), 返回比分/状态/日志
 *   GET   /api/v1/health → 服务状态、核心 hash、评测占用
 *   GET   /api/v1/schema → AI 动作/观测/评测协议
 *   POST  /api/v1/evaluations → 异步多 seed 评测(默认快速模式)
 *   GET   /api/v1/evaluations/:id → 评测进度与汇总
 *   GET   /state          → 全量状态(双车传感器/FSM/比分/日志)
 *   GET   /log            → 事件日志
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCore, runBattle } = require('./sim_lib');

const PORT = parseInt(process.argv[2] || process.env.SIM_PORT || '8932', 10);
const api = loadCore(__dirname);
const { resetAll, arm, startManual, stepSim, stepSimExt, getState, getLog, setParams, setVehicleFor, getVehicleFor, setPose, setObject, scenePreset, params, scoreBoard,
  beginPreparation, pauseMatch, resumeMatch, restartFor } = api;
const SERVER_STARTED_AT = new Date().toISOString();
const CORE_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, 'wushu_ring_sim.html'), 'utf8'))
  .digest('hex').slice(0, 16);

// ---------- 计分基准(每步返回奖励增量) ----------
let scoreBase = { us: 0, them: 0 };
function snapshotReward(){
  const us = scoreBoard.us - scoreBase.us;
  const them = scoreBoard.them - scoreBase.them;
  scoreBase = { us: scoreBoard.us, them: scoreBoard.them };
  return { us, them, total: us - them };
}

// ---------- 后台对战会话 (GUI 导入/远程对战用, 不阻塞 /state 轮询) ----------
const ROBOTS_DIR = path.join(__dirname, 'robots');
const REGISTRY_FILE = path.join(__dirname, 'sim_robots.json');
if (!fs.existsSync(ROBOTS_DIR)) fs.mkdirSync(ROBOTS_DIR);
let battleSession = { running: false, abort: false, startedAt: 0, result: null, error: null, usName: '', themName: '', output: [] };

// ---------- AI 批量评测任务 ----------
// 核心是单例，因此本机服务同一时刻只运行一个评测任务；任务本身异步执行，
// 外部 Python 策略的 1:1 实时节流不会阻塞 HTTP 轮询。
const EVAL_SEEDS = [42, 7, 21, 100, 123];
const evaluations = new Map();
let evaluationSeq = 0;
const MAX_EVALUATIONS = 24;

function safeName(value, fallback='candidate'){
  const s = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || fallback).slice(0, 48);
}
function codeHash(code){
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12);
}
function materializeCandidate(body){
  const candidate = body && body.candidate && typeof body.candidate === 'object' ? body.candidate : null;
  const code = candidate && typeof candidate.code === 'string' ? candidate.code : (typeof body.code === 'string' ? body.code : null);
  if (code === null) return { us: body.us || 'fsm', them: body.them || 'fsm', candidate: null };
  if (Buffer.byteLength(code, 'utf8') > 1024 * 1024) throw new Error('候选算法代码不能超过 1MB');
  const role = (candidate && candidate.role) || body.role || 'us';
  if (role !== 'us' && role !== 'them') throw new Error("candidate.role 必须是 'us' 或 'them'");
  const stem = `ai_${safeName((candidate && (candidate.name || candidate.filename)) || body.name || 'candidate')}_${codeHash(code)}`;
  const file = stem + '.py';
  const filePath = path.join(ROBOTS_DIR, file);
  fs.writeFileSync(filePath, code, 'utf8');
  const command = `python robot_adapter.py robots/${file}`;
  return {
    us: role === 'us' ? command : (body.us || 'fsm'),
    them: role === 'them' ? command : (body.them || 'fsm'),
    candidate: { name: stem, role, file: `robots/${file}`, hash: codeHash(code) },
  };
}
function evaluationBusy(){
  return [...evaluations.values()].some(j => j.status === 'queued' || j.status === 'running');
}
function normalizeSeeds(value){
  const raw = Array.isArray(value) && value.length ? value : EVAL_SEEDS;
  const out = [];
  for (const x of raw){
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new Error('seeds 必须是非负整数数组');
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) throw new Error('至少需要一个 seed');
  if (out.length > 32) throw new Error('单次最多评测 32 个 seed');
  return out;
}
function summarizeEvaluation(runs){
  const okRuns = runs.filter(r => !r.error);
  const count = okRuns.length;
  const sum = key => okRuns.reduce((n, r) => n + Number(r[key] || 0), 0);
  const netScores = okRuns.map(r => Number(r.netScore || 0));
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const wins = okRuns.filter(r => r.netScore > 0).length;
  const draws = okRuns.filter(r => r.netScore === 0).length;
  const mounts = okRuns.filter(r => r.metrics && r.metrics.us && r.metrics.us.mounted).length;
  return {
    count,
    failed: runs.length - count,
    meanNetScore: +mean(netScores).toFixed(3),
    meanUsScore: +(sum('usScore') / (count || 1)).toFixed(3),
    meanThemScore: +(sum('themScore') / (count || 1)).toFixed(3),
    winRate: +(wins / (count || 1)).toFixed(3),
    drawRate: +(draws / (count || 1)).toFixed(3),
    mountRate: +(mounts / (count || 1)).toFixed(3),
    bestNetScore: netScores.length ? Math.max(...netScores) : null,
    worstNetScore: netScores.length ? Math.min(...netScores) : null,
  };
}
function publicEvaluation(job){
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    candidate: job.candidate,
    us: job.us,
    them: job.them,
    seeds: job.seeds,
    progress: { completed: job.runs.length, total: job.seeds.length, currentSeed: job.currentSeed },
    summary: job.summary,
    runs: job.runs,
    error: job.error,
  };
}
function trimEvaluations(){
  while (evaluations.size > MAX_EVALUATIONS){
    const first = evaluations.keys().next().value;
    if (!first) break;
    const old = evaluations.get(first);
    if (old.status === 'queued' || old.status === 'running') break;
    evaluations.delete(first);
  }
}
async function runEvaluation(job, opts){
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    for (const seed of job.seeds){
      if (job.cancelRequested) break;
      job.currentSeed = seed;
      const started = Date.now();
      try {
        const result = await runBattle({
          api,
          seed,
          params: opts.params,
          scene: opts.scene,
          vehicles: opts.vehicles,
          dt: opts.dt,
          maxSteps: opts.maxSteps,
          actionTimeout: opts.actionTimeout,
          traceEvery: opts.traceEvery,
          realtime: opts.realtime,
          us: job.us,
          them: job.them,
          shouldAbort: () => !!job.cancelRequested,
        });
        const usScore = Number(result.scores && result.scores.us || 0);
        const themScore = Number(result.scores && result.scores.them || 0);
        const row = {
          seed,
          ok: true,
          usScore,
          themScore,
          netScore: usScore - themScore,
          simT: result.simT,
          steps: result.steps,
          done: result.done,
          doneReason: result.doneReason,
          metrics: result.metrics,
          elapsedMs: Date.now() - started,
          logTail: result.logTail,
        };
        if (opts.includeTrace) row.trace = result.trace;
        job.runs.push(row);
      } catch (e) {
        job.runs.push({ seed, ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - started });
      }
      job.summary = summarizeEvaluation(job.runs);
    }
    job.status = job.cancelRequested ? 'cancelled' : 'done';
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.message || e);
  } finally {
    job.currentSeed = null;
    job.finishedAt = new Date().toISOString();
    job.summary = summarizeEvaluation(job.runs);
    trimEvaluations();
  }
}

function registryAdd(name, cmd, desc){
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) {}
  reg[name] = { cmd, desc: desc || '上传的小车程序' };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}
function registryList(){
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) { return {}; }
}
function battleStatus(){
  const s = getState();
  return {
    running: battleSession.running,
    startedAt: battleSession.startedAt,
    us: battleSession.usName, them: battleSession.themName,
    simT: s.simT, scores: s.scores,
    done: !battleSession.running && !!battleSession.result,
    doneReason: (battleSession.result && battleSession.result.doneReason) || battleSession.error || '',
    logTail: getLog().slice(-25),
    output: battleSession.output.slice(-60),   // 子进程输出(对手/我方程序 stderr 等)
  };
}

// ---------- HTTP ----------
function json(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/') {
      return json(res, 200, {
        name: 'wushu-ring-sim headless API (双车 + 子进程桥)',
        version: '2026',
        apiVersion: 'v1',
        core: '3D GameEngine; rules CORE compatibility source',
        endpoints: ['GET /health', 'GET /schema', 'POST /reset', 'POST /arm', 'POST /step', 'POST /step2', 'POST /params', 'GET /vehicle', 'POST /vehicle', 'POST /scene', 'POST /battle/run', 'POST /battle/start', 'POST /battle/stop', 'GET /battle/status', 'POST /api/v1/evaluations', 'GET /api/v1/evaluations/:id', 'DELETE /api/v1/evaluations/:id', 'GET /state', 'GET /log', 'GET /referee/state', 'POST /referee/pause', 'POST /referee/resume', 'POST /referee/restart'],
        state: getState().robots.us.state,
      });
    }
    if (req.method === 'GET' && (u.pathname === '/health' || u.pathname === '/api/v1/health')) {
      return json(res, 200, {
        ok: true,
        name: 'wushu-ring-sim',
        apiVersion: 'v1',
        version: '2026',
        coreHash: CORE_HASH,
        startedAt: SERVER_STARTED_AT,
        uptimeSec: Math.round(process.uptime()),
        state: getState().robots.us.state,
        evaluationBusy: evaluationBusy(),
        endpoints: {
          schema: '/api/v1/schema',
          evaluate: '/api/v1/evaluations',
          state: '/state',
        },
      });
    }
    if (req.method === 'GET' && (u.pathname === '/schema' || u.pathname === '/api/v1/schema')) {
      return json(res, 200, {
        apiVersion: 'v1',
        coreHash: CORE_HASH,
        deterministic: { seed: true, fixedSeedSet: EVAL_SEEDS },
        action: {
          type: 'object',
          fields: {
            v: { type: 'number', unit: 'm/s', range: [-3, 3] },
            w: { type: 'number', unit: 'rad/s', range: [-12, 12] },
          },
        },
        observation: {
          state: '/state',
          perRobot: ['x', 'y', 'th', 'v', 'w', 'vehicle', 'onPlatform', 'hang', 'state', 'action'],
          sensors: ['sensors (legacy aliases)', 'rawSensors (real channels)', 'sensorLayout (type/position/orientation)'],
          objects: ['buffs', 'debuff'],
        },
        evaluation: {
          endpoint: '/api/v1/evaluations',
          defaultSeeds: EVAL_SEEDS,
          maxSeeds: 32,
          request: {
            us: 'fsm | @registryName | command',
            them: 'fsm | @registryName | command',
            candidate: '{name?, role?, code?}',
            seeds: 'integer[]',
            includeTrace: 'boolean',
            realtime: 'boolean? (默认 false，实车线程联调时设 true)',
            params: 'object?',
            vehicles: '{us?,them?}',
            scene: 'object?'
          },
          resultMetrics: ['meanNetScore', 'winRate', 'drawRate', 'mountRate', 'bestNetScore', 'worstNetScore'],
        },
      });
    }
    if (req.method === 'POST' && (u.pathname === '/api/v1/evaluations' || u.pathname === '/batch/start')) {
      if (evaluationBusy()) return json(res, 409, { error: '已有评测任务运行中；单例核心不支持并行评测' });
      if (battleSession.running) return json(res, 409, { error: '已有远程对战运行中，请先停止 /battle/stop' });
      const b = await readBody(req);
      const material = materializeCandidate(b);
      const seeds = normalizeSeeds(b.seeds);
      const id = `eval-${Date.now().toString(36)}-${(++evaluationSeq).toString(36)}`;
      const job = {
        id,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        cancelRequested: false,
        currentSeed: null,
        candidate: material.candidate,
        us: material.us,
        them: material.them,
        seeds,
        runs: [],
        summary: summarizeEvaluation([]),
        error: null,
      };
      evaluations.set(id, job);
      trimEvaluations();
      const opts = {
        params: b.params,
        scene: b.scene,
        vehicles: b.vehicles,
        dt: Number.isFinite(Number(b.dt)) ? Math.max(0.01, Math.min(0.2, Number(b.dt))) : 0.05,
        maxSteps: Number.isFinite(Number(b.maxSteps)) ? Math.max(1, Math.min(20000, Math.floor(Number(b.maxSteps)))) : 2400,
        traceEvery: Number.isFinite(Number(b.traceEvery)) ? Math.max(1, Math.min(1000, Math.floor(Number(b.traceEvery)))) : 20,
        actionTimeout: Number.isFinite(Number(b.actionTimeout)) ? Math.max(10, Math.min(5000, Math.floor(Number(b.actionTimeout)))) : 300,
        includeTrace: !!b.includeTrace,
        // AI 批量搜索默认关闭真实时间节流；@realcar 等依赖线程时序的实车桥请显式传 true。
        realtime: b.realtime === true,
      };
      setImmediate(() => runEvaluation(job, opts));
      return json(res, 202, { ok: true, id, status: job.status, poll: `/api/v1/evaluations/${id}`, candidate: job.candidate, seeds });
    }
    const evalPathMatch = u.pathname.match(/^\/api\/v1\/evaluations\/([^/]+)$/);
    if ((req.method === 'GET' || req.method === 'DELETE') && evalPathMatch){
      const job = evaluations.get(evalPathMatch[1]);
      if (!job) return json(res, 404, { error: '评测任务不存在', id: evalPathMatch[1] });
      if (req.method === 'DELETE'){
        if (job.status === 'queued' || job.status === 'running') job.cancelRequested = true;
        return json(res, 202, { ok: true, id: job.id, status: job.status === 'done' ? job.status : 'cancelling' });
      }
      return json(res, 200, publicEvaluation(job));
    }
    if (req.method === 'GET' && u.pathname === '/batch/status'){
      const id = u.searchParams.get('id');
      const job = id && evaluations.get(id);
      if (!job) return json(res, 404, { error: '请提供有效的 ?id=评测任务 ID' });
      return json(res, 200, publicEvaluation(job));
    }
    if (req.method === 'POST' && u.pathname === '/batch/cancel'){
      const id = u.searchParams.get('id');
      const job = id && evaluations.get(id);
      if (!job) return json(res, 404, { error: '请提供有效的 ?id=评测任务 ID' });
      if (job.status === 'queued' || job.status === 'running') job.cancelRequested = true;
      return json(res, 202, { ok: true, id, status: 'cancelling' });
    }
    if (req.method === 'POST' && u.pathname === '/reset') {
      if (evaluationBusy()) return json(res, 409, { error: '评测任务运行中，不能重置单例比赛核心' });
      const b = await readBody(req);
      resetAll({ seed: b.seed ?? params.seed, params: b.params, scene: b.scene, vehicles: b.vehicles });
      if (b.manual) startManual();
      scoreBase = { us: scoreBoard.us, them: scoreBoard.them };
      return json(res, 200, { ok: true, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/arm') {
      arm();
      return json(res, 200, { ok: true, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/step') {
      const b = await readBody(req);
      const dt = typeof b.dt === 'number' ? b.dt : 0.05;
      stepSim(dt, b.action);
      const st = getState();
      return json(res, 200, { state: st, reward: snapshotReward(), done: st.done, doneReason: st.doneReason, step: b });
    }
    if (req.method === 'POST' && u.pathname === '/step2') {
      const b = await readBody(req);
      const dt = typeof b.dt === 'number' ? b.dt : 0.05;
      stepSimExt(dt, { us: b.us || null, them: b.them || null });
      const st = getState();
      return json(res, 200, { state: st, reward: snapshotReward(), done: st.done, doneReason: st.doneReason });
    }
    if (req.method === 'POST' && u.pathname === '/params') {
      const b = await readBody(req);
      setParams(b);
      return json(res, 200, { ok: true, params });
    }
    if (req.method === 'GET' && u.pathname === '/vehicle') {
      const role = u.searchParams.get('role') || 'us';
      if (role !== 'us' && role !== 'them') return json(res, 400, { error: "role 必须是 'us' 或 'them'" });
      return json(res, 200, { ok: true, role, vehicle: getVehicleFor(role) });
    }
    if (req.method === 'POST' && u.pathname === '/vehicle') {
      const b = await readBody(req);
      const role = b.role || 'us';
      if (role !== 'us' && role !== 'them') return json(res, 400, { error: "role 必须是 'us' 或 'them'" });
      const vehicle = b.vehicle && typeof b.vehicle === 'object' ? b.vehicle : b;
      if (!vehicle || typeof vehicle !== 'object' || Array.isArray(vehicle)) {
        return json(res, 400, { error: 'vehicle 必须是对象' });
      }
      const applied = setVehicleFor(role, vehicle);
      return json(res, 200, { ok: true, role, vehicle: applied, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/scene') {
      const b = await readBody(req);
      if (b.preset) scenePreset(b.preset);
      if (b.robot) setPose(b.robot.x, b.robot.y, b.robot.th ?? 0);
      if (b.opp) setObject('opp', 0, b.opp.x, b.opp.y);
      if (Array.isArray(b.buffs)) b.buffs.forEach((p, i) => setObject('buff', i, p.x, p.y));
      if (b.debuff) setObject('debuff', 0, b.debuff.x, b.debuff.y);
      return json(res, 200, { ok: true, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/battle/run') {
      if (evaluationBusy()) return json(res, 409, { error: '评测任务运行中，请等待完成或取消后再运行单场对战' });
      const b = await readBody(req);
      const r = await runBattle({
        api,
        seed: b.seed,
        params: b.params,
        scene: b.scene,          // 预设场景(如 {preset:'center'} 车放台上中心)
        vehicles: b.vehicles,
        dt: b.dt, maxSteps: b.maxSteps,
        us: b.us ?? 'fsm', them: b.them ?? 'fsm',
        actionTimeout: b.actionTimeout,
        traceEvery: b.traceEvery,
      });
      return json(res, 200, r);
    }
    // 上传小车程序 (GUI 导入): 保存到 robots/ 并注册到 sim_robots.json
    if (req.method === 'POST' && u.pathname === '/upload') {
      const b = await readBody(req);
      if (!b.filename || typeof b.code !== 'string') return json(res, 400, { error: 'filename/code 必填' });
      const name = path.basename(b.filename).replace(/\.py$/i, '').replace(/[^\w\-]/g, '_');
      const file = name + '.py';
      fs.writeFileSync(path.join(ROBOTS_DIR, file), b.code, 'utf8');
      registryAdd(name, `python robot_adapter.py robots/${file}`, '上传的小车程序');
      return json(res, 200, { ok: true, name, file: `robots/${file}` });
    }
    // 文件夹导入 (GUI "导入代码文件夹"): 不复制, 直接引用本地文件夹里的入口程序。
    // 仿真器跑在本机, 引用路径 = 实时读用户最新代码; 适配器会把入口所在目录加进 sys.path,
    // 所以入口文件 import 同级模块/子包(actuator/ strategy/ ...)都能找到。
    if (req.method === 'POST' && u.pathname === '/import-dir') {
      const b = await readBody(req);
      if (!b.dir) return json(res, 400, { error: 'dir 必填, 如 D:\\project\\robocup\\robocup-2026-wheeled-combat' });
      // 路径清洗: 去首尾引号/空格; Git Bash 风格 /d/xxx → D:\xxx; 反斜杠统一
      let dir = String(b.dir).trim().replace(/^["']+|["']+$/g, '');
      if (/^\/[a-zA-Z]\//.test(dir)) dir = dir[1].toUpperCase() + ':' + dir.slice(2);
      dir = path.resolve(dir.replace(/\//g, path.sep));
      if (!fs.existsSync(dir)) return json(res, 400, { error: '目录不存在: ' + dir });
      if (!fs.statSync(dir).isDirectory()) return json(res, 400, { error: '不是目录: ' + dir });
      // 入口文件: 显式指定; 或自动探测——从用户目录向上最多 3 层找
      // (支持填子目录如 .../tools 或 .../robocup-2026-wheeled-combat/strategy)
      let entry = null;
      const searched = [];
      if (b.entry){
        // entry 支持相对路径(dir 下) 或绝对路径
        const ep = String(b.entry).trim().replace(/^["']+|["']+$/g, '');
        const p = path.isAbsolute(ep) ? ep : path.join(dir, ep);
        searched.push(p);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) entry = p;
      } else {
        let searchDir = dir;
        for (let depth = 0; depth <= 3 && !entry; depth++){
          for (const c of ['tools/sim_robot_main.py', 'sim_robot_main.py', 'main.py']){
            const p = path.join(searchDir, c);
            searched.push(p);
            if (fs.existsSync(p) && fs.statSync(p).isFile()){ entry = p; break; }
          }
          if (entry) break;
          const parent = path.dirname(searchDir);
          if (parent === searchDir) break;
          searchDir = parent;
        }
      }
      if (!entry) return json(res, 400, {
        error: '找不到入口文件。已探测: ' + searched.join(' ; ') + '。\n检查: ①路径是否为项目根目录(含 main.py / tools/sim_robot_main.py) ②入口留空自动探测, 或手动填 entry',
        dir,
      });
      const name = (b.name || path.basename(dir)).replace(/[^\w\-]/g, '_');
      registryAdd(name, `python robot_adapter.py ${entry}`, `文件夹导入: ${dir} (入口 ${path.basename(entry)})`);
      return json(res, 200, { ok: true, name, entry, dir });
    }
    // 后台对战: 启动 (GUI 远程对战用, 期间 /state 轮询实时渲染)
    if (req.method === 'POST' && u.pathname === '/battle/start') {
      const b = await readBody(req);
      if (evaluationBusy()) return json(res, 409, { error: '评测任务运行中，请等待完成或取消后再启动远程对战' });
      if (battleSession.running) return json(res, 409, { error: '已有对战进行中, 先 /battle/stop' });
      resetAll({ seed: b.seed, params: b.params, vehicles: b.vehicles });
      scoreBase = { us: scoreBoard.us, them: scoreBoard.them };
      battleSession = {
        running: true, abort: false, startedAt: Date.now(), result: null, error: null,
        usName: b.us || 'fsm', themName: b.them || 'fsm', output: [],
      };
      runBattle({
        api,
        seed: b.seed, params: b.params,
        vehicles: b.vehicles,
        dt: b.dt, maxSteps: b.maxSteps || 2400,
        us: b.us ?? 'fsm', them: b.them ?? 'fsm',
        actionTimeout: b.actionTimeout,
        traceEvery: b.traceEvery,
        shouldAbort: () => battleSession.abort,
        onLog: m => {
          battleSession.output.push(m);
          if (battleSession.output.length > 200) battleSession.output.shift();
        },
      }).then(r => {
        battleSession.result = r;
        battleSession.running = false;
      }).catch(e => {
        battleSession.error = String(e && e.message || e);
        battleSession.running = false;
      });
      return json(res, 200, { ok: true, started: true, us: battleSession.usName, them: battleSession.themName });
    }
    if (req.method === 'POST' && u.pathname === '/battle/stop') {
      battleSession.abort = true;
      return json(res, 200, { ok: true, abortRequested: true });
    }
    if (req.method === 'GET' && u.pathname === '/battle/status') {
      return json(res, 200, battleStatus());
    }
    if (req.method === 'GET' && u.pathname === '/registry') {
      return json(res, 200, registryList());
    }
    if (req.method === 'GET' && u.pathname === '/referee/state') {
      const st = getState();
      return json(res, 200, { match:st.match, scores:st.scores, done:st.done, doneReason:st.doneReason });
    }
    if (req.method === 'POST' && u.pathname === '/referee/pause') {
      const b = await readBody(req);
      pauseMatch(b.reason);
      return json(res, 200, { ok:true, match:getState().match });
    }
    if (req.method === 'POST' && u.pathname === '/referee/resume') {
      resumeMatch();
      return json(res, 200, { ok:true, match:getState().match });
    }
    if (req.method === 'POST' && u.pathname === '/referee/restart') {
      const b = await readBody(req);
      const points = restartFor(b.role || 'us', b.kind || 'debug');
      return json(res, 200, { ok:true, points, state:getState() });
    }
    if (req.method === 'GET' && u.pathname === '/state') {
      return json(res, 200, getState());
    }
    if (req.method === 'GET' && u.pathname === '/log') {
      return json(res, 200, { log: getLog() });
    }
    json(res, 404, { error: 'not found', path: u.pathname });
  } catch (e) {
    json(res, 400, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[sim_server] 无头 API 已启动: http://127.0.0.1:${PORT}`);
  console.log(`[sim_server] 状态: ${getState().robots.us.state} | 例子:`);
  console.log(`  curl -X POST localhost:${PORT}/battle/run -H 'Content-Type: application/json' -d '{"seed":42}'`);
  console.log(`  curl -X POST localhost:${PORT}/battle/run -H 'Content-Type: application/json' -d '{"us":"python robot_adapter.py example_robot.py","them":"fsm","seed":7}'`);
});
