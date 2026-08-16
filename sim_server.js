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
 *   POST  /scene          → 摆场景: {preset} 或 {us:{x,y,th}, them:{x,y,th}, vehicles?, buffs, debuff}
 *   POST  /battle/run     → {us?:'fsm'|命令, them?:'fsm'|命令, vehicles?, seed?, dt?, maxSteps?}
 *                            跑一整场(可子进程), 返回比分/状态/日志
 *   POST  /battle/control → 后台对战会话专用控制（需 /battle/start 返回的令牌）
 *   GET   /api/v1/health → 服务状态、核心 hash、评测占用
 *   GET   /api/v1/schema → AI 动作/观测/评测协议
 *   POST  /api/v1/evaluations → 异步多 seed 评测(默认快速模式)
 *   GET   /api/v1/evaluations/:id → 评测进度与汇总
 *   GET   /state          → 全量状态；?compact=1 返回 AI/远程 UI 所需紧凑状态
 *   GET   /log            → 事件日志
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadCore, runBattle, invalidateRegistry } = require('./sim_lib');

const PORT = parseInt(process.argv[2] || process.env.SIM_PORT || '8932', 10);
const api = loadCore(__dirname);
const { resetAll, arm, startManual, stepSim, stepSimExt, getState, getLog, setParams, setVehicleFor, getVehicleFor, setFieldGrayMap, getFieldGrayMap, getFieldGrayInfo, setPose, setPoseFor, setObject, scenePreset, params, scoreBoard, US, THEM,
  beginPreparation, pauseMatch, resumeMatch, restartFor, setExternalVisionCache, updateExternalVisionResult,
  clearExternalVisionCache, getSimVisionInfo } = api;
const SERVER_STARTED_AT = new Date().toISOString();
const CORE_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, 'wushu_ring_sim.html'), 'utf8'))
  .digest('hex').slice(0, 16);
const FIDELITY_FILE = path.join(__dirname, 'fidelity.json');

function fidelitySnapshot(){
  try {
    const fidelity = JSON.parse(fs.readFileSync(FIDELITY_FILE, 'utf8'));
    const subsystems = fidelity && fidelity.subsystems && typeof fidelity.subsystems === 'object' ? fidelity.subsystems : {};
    const byStatus = {};
    for (const [name, detail] of Object.entries(subsystems)){
      const status = detail && detail.status || 'unknown';
      if (!byStatus[status]) byStatus[status] = [];
      byStatus[status].push(name);
    }
    return { available: true, updatedAt: fidelity.updatedAt || null, byStatus, fidelity };
  } catch (error) {
    return { available: false, error: `无法读取 fidelity.json: ${error.message}`, byStatus: {} };
  }
}
function fieldGraySnapshot(){
  const info = getFieldGrayInfo();
  const map = getFieldGrayMap();
  // 评测复现需要区分“同尺寸、同 id 但数值不同”的灰度表；默认手绘模型
  // 没有数组值，因此用版本化描述串作为稳定摘要。
  const material = map
    ? JSON.stringify({ id:map.id, width:map.width, height:map.height, values:map.values,
      bounds:map.bounds, interpolation:map.interpolation })
    : 'hand_drawn:fieldGray-v1';
  const sha256 = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return { ...info, sha256 };
}
function stateForRequest(url, body){
  const compact = url && url.searchParams && url.searchParams.get('compact') === '1'
    || !!(body && body.compact === true);
  return getState(compact ? { compact:true } : undefined);
}

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
let battleSession = { status: 'idle', running: false, abort: false, stop: null, controlToken: '', startedAt: 0, stopStartedAt: 0, result: null, error: null, usName: '', themName: '', output: [] };
let foregroundBattleRunning = false;

// 外部 YOLO 视觉桥接状态。默认关闭，关闭时完全沿用 CORE 的 classifyRate。
const visionConfig = { enabled:false, maxAgeMs:800, fps:5, width:640, quality:0.7, fallback:'classifyRate', fixedLabel:'' };
const visionFrames = {
  us:{frameId:null, at:null, lastLabel:null, errorCount:0, lastError:null, lastErrorAt:null, lastSuccessAt:null, consecutiveFailures:0},
  them:{frameId:null, at:null, lastLabel:null, errorCount:0, lastError:null, lastErrorAt:null, lastSuccessAt:null, consecutiveFailures:0},
};
function resetVisionFrames(preserveErrors=false){
  for(const role of ['us','them']){
    const old=visionFrames[role];
    visionFrames[role]={frameId:null,at:null,lastLabel:null,
      errorCount:preserveErrors ? Number(old.errorCount||0) : 0,
      lastError:preserveErrors ? (old.lastError||null) : null,
      lastErrorAt:preserveErrors ? (old.lastErrorAt||null) : null,
      lastSuccessAt:preserveErrors ? (old.lastSuccessAt||null) : null,
      consecutiveFailures:preserveErrors ? Number(old.consecutiveFailures||0) : 0,
    };
  }
}
function recordVisionError(role, message){
  const key=role==='us'||role==='them'?role:null;
  if(key){
    visionFrames[key].errorCount=Number(visionFrames[key].errorCount||0)+1;
    visionFrames[key].lastError=String(message||'视觉请求失败').slice(0,500);
    visionFrames[key].lastErrorAt=Date.now();
    visionFrames[key].consecutiveFailures=Number(visionFrames[key].consecutiveFailures||0)+1;
  } else {
    for(const r of ['us','them']){
      visionFrames[r].errorCount=Number(visionFrames[r].errorCount||0)+1;
      visionFrames[r].lastError=String(message||'视觉请求失败').slice(0,500);
      visionFrames[r].lastErrorAt=Date.now();
      visionFrames[r].consecutiveFailures=Number(visionFrames[r].consecutiveFailures||0)+1;
    }
  }
}
function recordVisionSuccess(role){
  const key=role==='us'||role==='them'?role:null;
  if(!key) return;
  visionFrames[key].lastSuccessAt=Date.now();
  visionFrames[key].consecutiveFailures=0;
  visionFrames[key].lastError=null;
}
function visionStatus(){
  const now=Date.now();
  const roles={};
  for(const role of ['us','them']){
    const v=visionFrames[role];
    roles[role]={frameId:v.frameId, ageMs:v.at===null?null:Math.max(0,now-v.at), lastLabel:v.lastLabel, errorCount:v.errorCount,
      lastError:v.lastError, lastErrorAt:v.lastErrorAt, lastSuccessAt:v.lastSuccessAt,
      consecutiveFailures:v.consecutiveFailures};
  }
  const info=typeof getSimVisionInfo==='function'?getSimVisionInfo():null;
  return { enabled:visionConfig.enabled, mode:visionConfig.enabled?'external':'default', settings:{...visionConfig}, roles, core:info };
}
function validVisionConfig(b){
  const out={...visionConfig};
  if(b.enabled!==undefined){ if(typeof b.enabled!=='boolean') throw new Error('vision.enabled 必须是布尔值'); out.enabled=b.enabled; }
  for(const k of ['maxAgeMs','fps','width','quality']) if(b[k]!==undefined){
    const n=Number(b[k]); if(!Number.isFinite(n)) throw new Error(`vision.${k} 必须是数字`);
    out[k]=n;
  }
  out.maxAgeMs=Math.max(100,Math.min(10000,Math.round(out.maxAgeMs)));
  out.fps=Math.max(1,Math.min(30,Math.round(out.fps)));
  out.width=Math.max(160,Math.min(1920,Math.round(out.width)));
  out.quality=Math.max(0.1,Math.min(1,Number(out.quality)));
  if(b.fallback!==undefined && b.fallback!=='classifyRate') throw new Error("vision.fallback 目前只支持 'classifyRate'");
  out.fallback='classifyRate';
  if(b.fixedLabel!==undefined){
    if(!['','buff','debuff','opponent','unknown'].includes(String(b.fixedLabel)))
      throw new Error("vision.fixedLabel 必须为空、buff、debuff、opponent 或 unknown");
    out.fixedLabel=String(b.fixedLabel);
  }
  out.fixedLabel=String(out.fixedLabel||'');
  return out;
}
function visionFrameIsNew(role, frameId){
  const previous=visionFrames[role].frameId;
  if(previous===null) return true;
  const a=String(frameId), b=String(previous);
  const na=Number(a.match(/(-?\d+)$/)?.[1]), nb=Number(b.match(/(-?\d+)$/)?.[1]);
  if(Number.isFinite(na)&&Number.isFinite(nb)) return na>nb;
  return a>b;
}

// ---------- AI 批量评测任务 ----------
// 核心是单例，因此本机服务同一时刻只运行一个评测任务；任务本身异步执行，
// 外部 Python 策略的 1:1 实时节流不会阻塞 HTTP 轮询。
const EVAL_SEEDS = [42, 7, 21, 100, 123];
const evaluations = new Map();
let evaluationSeq = 0;
const MAX_EVALUATIONS = 24;
const MAX_INLINE_CANDIDATES = 128;

function safeName(value, fallback='candidate'){
  const s = String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || fallback).slice(0, 48);
}
function codeHash(code){
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 12);
}
function pruneInlineCandidates(keepFile){
  let files=[];
  try {
    files=fs.readdirSync(ROBOTS_DIR)
      .filter(name=>/^ai_[a-zA-Z0-9_-]+_[a-f0-9]{12}\.py$/.test(name))
      .map(name=>{
        const file=path.join(ROBOTS_DIR,name);
        let mtime=0;
        try { mtime=fs.statSync(file).mtimeMs; } catch (e) {}
        return {name,file,mtime};
      }).sort((a,b)=>b.mtime-a.mtime);
  } catch (e) { return; }
  const keep=new Set([keepFile]);
  for(const item of files){
    if(keep.has(item.name)) continue;
    if(keep.size < MAX_INLINE_CANDIDATES){ keep.add(item.name); continue; }
    try { fs.unlinkSync(item.file); } catch (e) {}
  }
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
  pruneInlineCandidates(file);
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
  const okRuns = runs.filter(r => r && r.ok === true);
  const count = okRuns.length;
  const sum = key => okRuns.reduce((n, r) => n + Number(r[key] || 0), 0);
  const netScores = okRuns.map(r => Number(r.netScore || 0));
  const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const wins = okRuns.filter(r => r.netScore > 0).length;
  const draws = okRuns.filter(r => r.netScore === 0).length;
  const mounts = okRuns.filter(r => r.metrics && r.metrics.us && r.metrics.us.mounted).length;
  const status = !runs.length ? 'pending' : (count === 0 ? 'error' : (count < runs.length ? 'partial' : 'ok'));
  const hasData = count > 0;
  return {
    status,
    count,
    failed: runs.length - count,
    // 全失败不能伪装成“0 分表现”：调用方应依据 status/error 处理，
    // 而不是把桥接故障误判成一个有效的零分策略。
    meanNetScore: hasData ? +mean(netScores).toFixed(3) : null,
    meanUsScore: hasData ? +(sum('usScore') / count).toFixed(3) : null,
    meanThemScore: hasData ? +(sum('themScore') / count).toFixed(3) : null,
    winRate: hasData ? +(wins / count).toFixed(3) : null,
    drawRate: hasData ? +(draws / count).toFixed(3) : null,
    mountRate: hasData ? +(mounts / count).toFixed(3) : null,
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
    metadata: job.metadata,
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
  const evaluationVisionConfig={...visionConfig};
  // 批量评测必须使用确定性的默认视觉，不能被浏览器/YOLO异步注入污染。
  setExternalVisionCache({enabled:false,maxAgeMs:visionConfig.maxAgeMs,clear:true});
  resetVisionFrames();
  try {
    for (const seed of job.seeds){
      if (job.cancelRequested) break;
      job.currentSeed = seed;
      clearExternalVisionCache();
      resetVisionFrames();
      const started = Date.now();
      try {
        const result = await runBattle({
          api,
          seed,
          params: opts.params,
          scene: opts.scene,
          fieldGray: opts.fieldGray,
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
          perception: result.perception,
          policyStats: result.policyStats,
          warnings: result.warnings || [],
          elapsedMs: Date.now() - started,
          logTail: result.logTail,
        };
        if (opts.includeTrace) row.trace = result.trace;
        job.runs.push(row);
        job.metadata.actual = {
          coreHash: CORE_HASH,
          fieldGray: fieldGraySnapshot(),
          vehicles: { us: getVehicleFor('us'), them: getVehicleFor('them') },
          fidelity: fidelitySnapshot(),
        };
      } catch (e) {
        job.runs.push({ seed, ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - started });
      }
      // 记录本次 seed 实际使用的环境，而不是只记录请求值；这对中途失败和
      // 未来扩展运行时 profile/感知插件尤其重要。
      job.metadata.actual = {
        coreHash: CORE_HASH,
        fieldGray: fieldGraySnapshot(),
        vehicles: { us: getVehicleFor('us'), them: getVehicleFor('them') },
        fidelity: fidelitySnapshot(),
      };
      job.summary = summarizeEvaluation(job.runs);
    }
    if (job.cancelRequested) job.status = 'cancelled';
    else if (!job.runs.length || job.runs.every(r => r && r.ok !== true)) job.status = 'error';
    else if (job.runs.some(r => !r || r.ok !== true)) job.status = 'partial';
    else job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = String(e && e.message || e);
  } finally {
    // 评测结束后恢复评测前的视觉开关，但不恢复评测期间产生的旧帧。
    Object.assign(visionConfig,evaluationVisionConfig);
    setExternalVisionCache({enabled:visionConfig.enabled,maxAgeMs:visionConfig.maxAgeMs,clear:true});
    resetVisionFrames();
    job.currentSeed = null;
    job.finishedAt = new Date().toISOString();
    job.summary = summarizeEvaluation(job.runs);
    if (job.status === 'error' && !job.error) job.error = '所有 seed 评测均失败';
    trimEvaluations();
  }
}

function registryAdd(name, cmd, desc){
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) {}
  reg[name] = { cmd, desc: desc || '上传的小车程序' };
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  invalidateRegistry();
}
function registryList(){
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) { return {}; }
}
function battleStatus(state){
  const s = state || getState();
  return {
    status: battleSession.status,
    running: battleSession.status === 'running',
    stopping: battleSession.status === 'stopping',
    startedAt: battleSession.startedAt,
    us: battleSession.usName, them: battleSession.themName,
    simT: s.simT, scores: s.scores,
    done: battleSession.status === 'idle' && !!battleSession.result,
    doneReason: (battleSession.result && battleSession.result.doneReason) || battleSession.error || '',
    logTail: getLog().slice(-25),
    output: battleSession.output.slice(-60),   // 子进程输出(对手/我方程序 stderr 等)
    // GUI 远程模式只需要一次请求：这里带上同一时刻的规则状态，避免 /state
    // 与 /battle/status 两次完整序列化/往返造成渲染卡顿。
    state: s,
  };
}

function coreBusyReason(){
  if (evaluationBusy()) return '评测任务运行中，单例核心不能接受外部状态修改';
  if (battleSession.status !== 'idle') return battleSession.status === 'stopping' ? '上一场远程对战仍在停止，请稍后再试' : '远程对战运行中，请使用 /battle/control 或先 /battle/stop';
  if (foregroundBattleRunning) return '单场对战运行中，单例核心不能接受外部状态修改';
  return '';
}
function rejectWhenCoreBusy(res){
  const error = coreBusyReason();
  if (!error) return false;
  json(res, 409, { error });
  return true;
}
// 视觉接口在远程对战期间仍可用，但只能由启动该会话的页面写入；
// 评测、前台整场对战和 stopping 状态一律拒绝，避免异步视觉污染单例 CORE。
function rejectVisionWhenBusy(res, body){
  if (evaluationBusy()){
    json(res, 409, { error:'评测任务运行中，视觉输入已锁定' });
    return true;
  }
  if (foregroundBattleRunning){
    json(res, 409, { error:'单场对战运行中，视觉输入已锁定' });
    return true;
  }
  if (battleSession.status === 'stopping'){
    json(res, 409, { error:'上一场远程对战仍在停止，请稍后再试' });
    return true;
  }
  if (battleSession.status === 'running'){
    if (!body || typeof body.controlToken !== 'string' || body.controlToken !== battleSession.controlToken){
      json(res, 403, { error:'远程对战视觉控制令牌无效' });
      return true;
    }
  }
  return false;
}
function applyFixedVisionLabel(detections){
  if (!visionConfig.fixedLabel || !Array.isArray(detections)) return detections;
  return detections.map(d => ({ ...d, label: visionConfig.fixedLabel }));
}
function finitePosePart(value, fallback){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function applyPose(role, pose, legacyHeading){
  if (!pose || typeof pose !== 'object' || Array.isArray(pose)) return;
  const robot = role === 'them' ? THEM : US;
  const x = finitePosePart(pose.x, robot.x);
  const y = finitePosePart(pose.y, robot.y);
  const th = finitePosePart(pose.th, legacyHeading === undefined ? robot.th : legacyHeading);
  setPoseFor(robot, x, y, th);
}
function applyScenePayload(body){
  const b = body && typeof body === 'object' ? body : {};
  if (b.preset) scenePreset(b.preset);
  if (b.vehicles && typeof b.vehicles === 'object'){
    if (b.vehicles.us && typeof b.vehicles.us === 'object') setVehicleFor('us', b.vehicles.us);
    if (b.vehicles.them && typeof b.vehicles.them === 'object') setVehicleFor('them', b.vehicles.them);
  }
  // 新接口: us/them 允许双车独立摆位和朝向；保留 robot/opp 兼容旧客户端。
  if (b.us) applyPose('us', b.us);
  else if (b.robot) applyPose('us', b.robot, 0);
  if (b.them) applyPose('them', b.them);
  else if (b.opp) applyPose('them', b.opp);
  if (Array.isArray(b.buffs)) b.buffs.forEach((p, i) => setObject('buff', i, p.x, p.y));
  if (b.debuff) setObject('debuff', 0, b.debuff.x, b.debuff.y);
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
        endpoints: ['GET /health', 'GET /fidelity', 'GET/POST /field-gray', 'GET /schema', 'GET /vision/status', 'POST /vision/config', 'POST /vision/result', 'POST /reset', 'POST /arm', 'POST /step', 'POST /step2', 'POST /params', 'GET /vehicle', 'POST /vehicle', 'POST /scene', 'POST /battle/run', 'POST /battle/start', 'POST /battle/control', 'POST /battle/stop', 'GET /battle/status', 'POST /api/v1/evaluations', 'GET /api/v1/evaluations/:id', 'DELETE /api/v1/evaluations/:id', 'GET /state', 'GET /log', 'GET /referee/state', 'POST /referee/pause', 'POST /referee/resume', 'POST /referee/restart'],
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
        coreBusy: !!coreBusyReason(),
        fidelitySummary: fidelitySnapshot().byStatus,
        fieldGray: fieldGraySnapshot(),
        vision: visionStatus(),
        endpoints: {
          schema: '/api/v1/schema',
          evaluate: '/api/v1/evaluations',
          state: '/state (全量) 或 /state?compact=1 (紧凑)',
          fidelity: '/fidelity',
          fieldGray: '/field-gray', vision: '/vision/status',
        },
      });
    }
    if (req.method === 'GET' && (u.pathname === '/fidelity' || u.pathname === '/api/v1/fidelity')) {
      const snapshot = fidelitySnapshot();
      return json(res, snapshot.available ? 200 : 503, {
        ok: snapshot.available,
        coreHash: CORE_HASH,
        updatedAt: snapshot.updatedAt || null,
        summary: snapshot.byStatus,
        fidelity: snapshot.fidelity || null,
        error: snapshot.error || null,
      });
    }
    if (req.method === 'GET' && (u.pathname === '/field-gray' || u.pathname === '/api/v1/field-gray')) {
      const includeValues = u.searchParams.get('values') === '1';
      return json(res, 200, { ok:true, fieldGray:fieldGraySnapshot(), map:includeValues ? getFieldGrayMap() : undefined });
    }
    if (req.method === 'POST' && (u.pathname === '/field-gray' || u.pathname === '/api/v1/field-gray')) {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      const map = b.reset === true || b.map === null ? null : (b.map === undefined ? b : b.map);
      setFieldGrayMap(map);
      return json(res, 200, { ok:true, fieldGray:fieldGraySnapshot(), state:getState() });
    }
    if (req.method === 'GET' && (u.pathname === '/schema' || u.pathname === '/api/v1/schema')) {
      return json(res, 200, {
        apiVersion: 'v1',
        coreHash: CORE_HASH,
        deterministic: { seed: true, fixedSeedSet: EVAL_SEEDS },
        fidelity: { endpoint: '/fidelity', statuses: ['calibrated', 'hand_drawn', 'random_stub', 'uncalibrated', 'verified'] },
        perception: {
          fieldGray: { endpoint:'/field-gray', reset:'POST {"reset":true}', map:'POST {id?, values, width?, height?, bounds?, interpolation?}' },
          vision: { endpoint:'/vision/status', config:'/vision/config', result:'/vision/result', interface:'external cache -> {label, confidence, source}', labels:['buff','debuff','opponent','unknown'], remoteAuth:'远程对战期间请求体需附带 /battle/start 返回的 controlToken', defaults:{enabled:false,maxAgeMs:800,fps:5,width:640,quality:0.7,fallback:'classifyRate',fixedLabel:''} },
        },
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
            scene: 'object?',
            fieldGray: '二维/扁平灰度表对象?'
          },
          resultMetrics: ['meanNetScore', 'winRate', 'drawRate', 'mountRate', 'bestNetScore', 'worstNetScore'],
        },
      });
    }
    if (req.method === 'GET' && (u.pathname === '/vision/status' || u.pathname === '/api/v1/vision/status')) {
      return json(res, 200, { ok:true, ...visionStatus() });
    }
    if (req.method === 'POST' && (u.pathname === '/vision/config' || u.pathname === '/api/v1/vision/config')) {
      let b;
      try { b=await readBody(req); }
      catch (e) { recordVisionError(null,e.message); return json(res,400,{error:e.message}); }
      if (rejectVisionWhenBusy(res,b)) return;
      let next;
      try { next=validVisionConfig(b); }
      catch (e) { recordVisionError(null,e.message); return json(res,400,{error:e.message}); }
      // 只有启停、缓存年龄语义或固定标签变化需要丢弃旧帧；
      // FPS、尺寸、JPEG 画质调整不应让当前有效检测瞬间消失。
      const cacheAffecting = next.enabled !== visionConfig.enabled
        || next.maxAgeMs !== visionConfig.maxAgeMs
        || next.fixedLabel !== visionConfig.fixedLabel;
      Object.assign(visionConfig,next);
      if (cacheAffecting) {
        setExternalVisionCache({enabled:visionConfig.enabled,maxAgeMs:visionConfig.maxAgeMs,clear:true});
        resetVisionFrames();
      } else {
        setExternalVisionCache({enabled:visionConfig.enabled,maxAgeMs:visionConfig.maxAgeMs,clear:false});
      }
      return json(res,200,{ok:true,...visionStatus()});
    }
    if (req.method === 'POST' && (u.pathname === '/vision/result' || u.pathname === '/api/v1/vision/result')) {
      let b;
      try { b=await readBody(req); } catch (e) { recordVisionError(null,e.message); return json(res,400,{error:e.message}); }
      if (rejectVisionWhenBusy(res,b)) return;
      if(!visionConfig.enabled){ recordVisionError(b && b.role,'YOLO视觉未启用'); return json(res,409,{error:'YOLO视觉未启用，请先 POST /vision/config {"enabled":true}'}); }
      const role=b.role;
      if(role!=='us'&&role!=='them'){ recordVisionError(null,"role 必须是 'us' 或 'them'"); return json(res,400,{error:"role 必须是 'us' 或 'them'"}); }
      if((typeof b.frameId!=='string'&&typeof b.frameId!=='number') || String(b.frameId).length>128){ recordVisionError(role,'frameId 必须是字符串或数字'); return json(res,400,{error:'frameId 必须是字符串或数字'}); }
      if(!Array.isArray(b.detections)||b.detections.length>128){ recordVisionError(role,'detections 必须是数组且最多 128 项'); return json(res,400,{error:'detections 必须是数组且最多 128 项'}); }
      for(const d of b.detections){
        if(!d||typeof d!=='object'||Array.isArray(d)){ recordVisionError(role,'detection 必须是对象'); return json(res,400,{error:'detection 必须是对象'}); }
        if(typeof d.label!=='string' || !['buff','debuff','opponent','unknown','good','gain','bonus','bad','penalty','enemy','robot','none','miss'].includes(d.label.toLowerCase())){ recordVisionError(role,'detection.label 无效'); return json(res,400,{error:'detection.label 无效'}); }
        if(d.confidence!==undefined && (!Number.isFinite(Number(d.confidence))||Number(d.confidence)<0||Number(d.confidence)>1)){ recordVisionError(role,'detection.confidence 必须在 0..1'); return json(res,400,{error:'detection.confidence 必须在 0..1'}); }
        if(d.bbox!==undefined && (!Array.isArray(d.bbox)||d.bbox.length!==4||d.bbox.some(x=>!Number.isFinite(Number(x))))){ recordVisionError(role,'detection.bbox 必须是四个数字'); return json(res,400,{error:'detection.bbox 必须是四个数字'}); }
      }
      if(!visionFrameIsNew(role,b.frameId)){ recordVisionError(role,'拒绝重复或乱序视觉帧'); return json(res,409,{error:'拒绝重复或乱序视觉帧',frameId:b.frameId,lastFrameId:visionFrames[role].frameId}); }
      const normalizedDetections=applyFixedVisionLabel(b.detections);
      let accepted=false;
      try {
        accepted=updateExternalVisionResult(role,{frameId:String(b.frameId),detections:normalizedDetections,width:b.width,height:b.height},Date.now());
      }
      catch (e) { recordVisionError(role,e.message); return json(res,500,{error:'视觉结果处理失败'}); }
      if(!accepted){ recordVisionError(role,'拒绝重复视觉帧'); return json(res,409,{error:'拒绝重复视觉帧'}); }
      visionFrames[role].frameId=String(b.frameId); visionFrames[role].at=Date.now();
      visionFrames[role].lastLabel=normalizedDetections[0]?.label || null;
      recordVisionSuccess(role);
      return json(res,200,{ok:true,role,frameId:visionFrames[role].frameId,status:visionStatus()});
    }
    if (req.method === 'POST' && (u.pathname === '/api/v1/evaluations' || u.pathname === '/batch/start')) {
      if (rejectWhenCoreBusy(res)) return;
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
        metadata: {
          requested: { coreHash: CORE_HASH, fieldGray: b.fieldGray || null, vehicles: b.vehicles || null, fidelity: fidelitySnapshot() },
          actual: null,
        },
      };
      evaluations.set(id, job);
      trimEvaluations();
      const opts = {
        params: b.params,
        scene: b.scene,
        fieldGray: b.fieldGray,
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
        const terminal = ['done','partial','error','cancelled'].includes(job.status);
        return json(res, terminal ? 200 : 202, { ok: true, id: job.id, status: terminal ? job.status : 'cancelling' });
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
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      resetAll({ seed: b.seed ?? params.seed, params: b.params, scene: b.scene, fieldGray: b.fieldGray, vehicles: b.vehicles });
      clearExternalVisionCache();
      resetVisionFrames();
      if (b.manual) startManual();
      scoreBase = { us: scoreBoard.us, them: scoreBoard.them };
      return json(res, 200, { ok: true, state: stateForRequest(u, b) });
    }
    if (req.method === 'POST' && u.pathname === '/arm') {
      if (rejectWhenCoreBusy(res)) return;
      arm();
      return json(res, 200, { ok: true, state: stateForRequest(u) });
    }
    if (req.method === 'POST' && u.pathname === '/step') {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      const dt = typeof b.dt === 'number' ? b.dt : 0.05;
      stepSim(dt, b.action);
      const st = stateForRequest(u, b);
      return json(res, 200, { state: st, reward: snapshotReward(), done: st.done, doneReason: st.doneReason, step: b });
    }
    if (req.method === 'POST' && u.pathname === '/step2') {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      const dt = typeof b.dt === 'number' ? b.dt : 0.05;
      stepSimExt(dt, { us: b.us || null, them: b.them || null });
      const st = stateForRequest(u, b);
      return json(res, 200, { state: st, reward: snapshotReward(), done: st.done, doneReason: st.doneReason });
    }
    if (req.method === 'POST' && u.pathname === '/params') {
      if (rejectWhenCoreBusy(res)) return;
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
      if (rejectWhenCoreBusy(res)) return;
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
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      applyScenePayload(b);
      return json(res, 200, { ok: true, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/battle/run') {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      foregroundBattleRunning = true;
      try {
        const r = await runBattle({
          api,
          seed: b.seed,
          params: b.params,
          scene: b.scene,          // 预设场景(如 {preset:'center'} 车放台上中心)
          fieldGray: b.fieldGray,
          vehicles: b.vehicles,
          dt: b.dt, maxSteps: b.maxSteps,
          us: b.us ?? 'fsm', them: b.them ?? 'fsm',
          actionTimeout: b.actionTimeout,
          traceEvery: b.traceEvery,
        });
        return json(res, 200, r);
      } finally {
        foregroundBattleRunning = false;
      }
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
      if (!b.dir) return json(res, 400, { error: 'dir 必填，请提供本地代码文件夹路径' });
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
      if (rejectWhenCoreBusy(res)) return;
      resetAll({ seed: b.seed, params: b.params, scene: b.scene, fieldGray: b.fieldGray, vehicles: b.vehicles });
      clearExternalVisionCache();
      resetVisionFrames();
      scoreBase = { us: scoreBoard.us, them: scoreBoard.them };
      const session = {
        status: 'running', running: true, abort: false, stop: null, controlToken: crypto.randomBytes(24).toString('hex'), startedAt: Date.now(), stopStartedAt: 0, result: null, error: null,
        usName: b.us || 'fsm', themName: b.them || 'fsm', output: [],
      };
      battleSession = session;
      const isCurrentSession = () => battleSession === session;
      runBattle({
        api,
        seed: b.seed, params: b.params,
        fieldGray: b.fieldGray,
        vehicles: b.vehicles,
        skipReset: true,
        dt: b.dt, maxSteps: b.maxSteps || 2400,
        us: b.us ?? 'fsm', them: b.them ?? 'fsm',
        actionTimeout: b.actionTimeout,
        traceEvery: b.traceEvery,
        realtime: b.realtime,
        shouldAbort: () => !isCurrentSession() || session.abort,
        onPolicies: controls => { if (isCurrentSession()) session.stop = controls.stop; },
        onLog: m => {
          session.output.push(m);
          if (session.output.length > 200) session.output.shift();
        },
      }).then(r => {
        if (!isCurrentSession()) return;
        session.result = r;
        session.status = 'idle';
        session.running = false;
        session.stop = null;
        session.controlToken = '';
      }).catch(e => {
        if (!isCurrentSession()) return;
        session.error = String(e && e.message || e);
        session.status = 'idle';
        session.running = false;
        session.stop = null;
        session.controlToken = '';
      });
      return json(res, 200, { ok: true, started: true, us: session.usName, them: session.themName, controlToken: session.controlToken });
    }
    // 后台对战占用同一个 CORE。只有握有启动响应令牌的页面能在比赛中调裁判、场景和参数，
    // 既避免外部请求串改物理状态，也保留远程 GUI 所需的比赛内控制。
    if (req.method === 'POST' && u.pathname === '/battle/control') {
      const b = await readBody(req);
      if (battleSession.status !== 'running') return json(res, 409, { error: battleSession.status === 'stopping' ? '上一场远程对战仍在停止' : '没有进行中的远程对战' });
      if (typeof b.token !== 'string' || b.token !== battleSession.controlToken){
        return json(res, 403, { error: '远程对战控制令牌无效' });
      }
      const command = b.command;
      if (command === 'arm') arm();
      else if (command === 'pause') pauseMatch(b.reason || 'remote-ui');
      else if (command === 'resume') resumeMatch();
      else if (command === 'restart') {
        const role = b.role === 'them' ? 'them' : 'us';
        const kind = b.kind === 'restart' ? 'restart' : 'debug';
        restartFor(role, kind);
      } else if (command === 'scene') {
        applyScenePayload(b.scene);
      } else if (command === 'params') {
        if (!b.params || typeof b.params !== 'object' || Array.isArray(b.params)){
          return json(res, 400, { error: 'params 必须是对象' });
        }
        setParams(b.params);
      } else {
        return json(res, 400, { error: '不支持的 battle/control command' });
      }
      return json(res, 200, { ok: true, command, state: getState() });
    }
    if (req.method === 'POST' && u.pathname === '/battle/stop') {
      if (battleSession.status === 'idle') return json(res, 200, { ok: true, abortRequested: false, status: 'idle', alreadyStopped: true });
      if (battleSession.status === 'stopping') return json(res, 202, { ok: true, abortRequested: true, status: 'stopping' });
      battleSession.status = 'stopping';
      battleSession.running = false;
      battleSession.stopStartedAt = Date.now();
      battleSession.abort = true;
      if (battleSession.stop) battleSession.stop();
      const stoppingSession = battleSession;
      // 策略子进程通常会在当前 step 内退出；若异常策略阻塞，有限兜底释放会话锁。
      setTimeout(() => {
        if (battleSession === stoppingSession && stoppingSession.status === 'stopping' && Date.now() - stoppingSession.stopStartedAt >= 5000) {
          stoppingSession.error = stoppingSession.error || '远程对战停止超时，已释放会话锁';
          stoppingSession.status = 'idle';
          stoppingSession.stop = null;
          stoppingSession.controlToken = '';
        }
      }, 5100).unref?.();
      return json(res, 202, { ok: true, abortRequested: true, status: 'stopping' });
    }
    if (req.method === 'GET' && u.pathname === '/battle/status') {
      return json(res, 200, battleStatus(stateForRequest(u)));
    }
    if (req.method === 'GET' && u.pathname === '/registry') {
      return json(res, 200, registryList());
    }
    if (req.method === 'GET' && u.pathname === '/referee/state') {
      const st = getState();
      return json(res, 200, { match:st.match, scores:st.scores, done:st.done, doneReason:st.doneReason });
    }
    if (req.method === 'POST' && u.pathname === '/referee/pause') {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      pauseMatch(b.reason);
      return json(res, 200, { ok:true, match:getState().match });
    }
    if (req.method === 'POST' && u.pathname === '/referee/resume') {
      if (rejectWhenCoreBusy(res)) return;
      resumeMatch();
      return json(res, 200, { ok:true, match:getState().match });
    }
    if (req.method === 'POST' && u.pathname === '/referee/restart') {
      if (rejectWhenCoreBusy(res)) return;
      const b = await readBody(req);
      const points = restartFor(b.role || 'us', b.kind || 'debug');
      return json(res, 200, { ok:true, points, state:getState() });
    }
    if (req.method === 'GET' && u.pathname === '/state') {
      return json(res, 200, stateForRequest(u));
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
