#!/usr/bin/env node
/* ============================================================
 * sim_lib.js — 仿真器公共库
 *   loadCore()   : 从兼容核心源 wushu_ring_sim.html 加载纯逻辑核心
 *   createGameEngine() : 将核心挂到 GameEngine/Referee/Sensor/Robot 分层
 *   runBattle()  : 跑一场对战, 任意一方/双方可用"用户自己的小车程序"(子进程)
 *
 * 子进程协议 (行分隔 JSON):
 *   → 子进程 stdin : {"t":..,"role":"us"|"them","timer":..,"scores":..,
 *                     "robot":{x,y,th,v,w,vehicle,onPlatform,hang,state,action},
 *                     "sensors":{兼容逻辑别名}, "rawSensors":{车辆真实通道},
 *                     "sensorLayout":{类型/位置/朝向}, "opponent":{...}, "objects":{...}}
 *   ← 子进程 stdout: {"v":..,"w":..}   (超时 300ms 未回 → 按零动作处理)
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { create: createGameEngine } = require('./game_engine');

function loadCore(dir){
  const html = fs.readFileSync(path.join(dir, 'wushu_ring_sim.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m || !m[1].includes('CORE-BEGIN')) throw new Error('wushu_ring_sim.html 中未找到 CORE 块');
  const moduleShim = { exports: {} };
  new Function('module', m[1])(moduleShim);
  return moduleShim.exports;
}

// ---------- 子进程策略 ----------
const PY_CANDIDATES = [
  'python', 'python3', 'py',
  'C:/Users/Neco/AppData/Local/Programs/Python/Python312/python.exe',
  'C:/Users/Neco/AppData/Local/Programs/Python/Python314/python.exe',
];
function resolveCmd(cmd){
  const parts = cmd.trim().split(/\s+/);
  let exe = parts[0];
  if (exe === 'python' || exe === 'python3' || exe === 'py'){
    const found = PY_CANDIDATES.find(p => p !== exe && fs.existsSync(p));
    if (found) exe = found;
  }
  return [exe, ...parts.slice(1)];
}
function spawnPolicy(cmd, role, onLog){
  const [exe, ...args] = resolveCmd(cmd);
  let child;
  try {
    // 统一以仿真器目录为工作目录，AI 从任意路径启动 sim_server.js 时，
    // `python robot_adapter.py robots/...` 仍能正确找到适配器和注册程序。
    child = spawn(exe, args, { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    onLog(`[${role}子进程] 启动失败: ${e.message}`);
    return null;
  }
  const policy = { queued: [], waiters: [], alive: true };
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let act = null;
      try { act = JSON.parse(line); } catch (e) { continue; }
      if (policy.waiters.length) policy.waiters.shift()(act);
      else policy.queued.push(act);
    }
  });
  child.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) onLog(`[${role}子进程 stderr] ${s.slice(0, 160)}`);
  });
  child.on('exit', code => { policy.alive = false; onLog(`[${role}子进程] 退出 code=${code}`); });
  child.on('error', e => { policy.alive = false; onLog(`[${role}子进程] 错误: ${e.message}`); });
  policy.child = child;
  policy.ask = (obs, timeoutMs) => new Promise(resolve => {
    if (!policy.alive) return resolve(null);
    if (policy.queued.length) return resolve(policy.queued.shift());
    let done = false;
    const finish = a => { if (!done){ done = true; resolve(a); } };
    const t = setTimeout(() => finish(null), timeoutMs || 300);
    policy.waiters.push(a => { clearTimeout(t); finish(a); });
    try { child.stdin.write(JSON.stringify(obs) + '\n'); }
    catch (e) { clearTimeout(t); finish(null); }
  });
  policy.kill = () => {
    // 取消时立刻释放正在等待子进程动作的 Promise；否则远程“停止”只能
    // 等待 actionTimeout，连续两台车的等待会让下一场启动看似卡死。
    policy.alive = false;
    while (policy.waiters.length) policy.waiters.shift()(null);
    try { child.kill(); } catch (e) {}
  };
  return policy;
}

// ---------- 观测构造 ----------
function mkObs(st, role){
  const r = st.robots[role];
  return {
    t: st.simT, role, timer: st.timer, scores: st.scores,
    match: st.match,
    robot: r,
    sensors: st.sensors[role],
    rawSensors: st.rawSensors ? st.rawSensors[role] : st.sensors[role],
    sensorCompat: st.sensorCompat ? st.sensorCompat[role] : st.sensors[role],
    sensorLayout: st.sensorLayout ? st.sensorLayout[role] : undefined,
    opponent: st.robots[role === 'us' ? 'them' : 'us'],
    objects: st.objects,
  };
}
function normAct(a, vehicle){
  if (!a) return null;
  const maxSpeed = Number.isFinite(Number(vehicle && vehicle.maxSpeed)) ? Number(vehicle.maxSpeed) : 1.5;
  const maxTurnRate = Number.isFinite(Number(vehicle && vehicle.maxTurnRate)) ? Number(vehicle.maxTurnRate) : 4;
  const v = typeof a.v === 'number' ? Math.max(-maxSpeed, Math.min(maxSpeed, a.v)) : 0;
  const w = typeof a.w === 'number' ? Math.max(-maxTurnRate, Math.min(maxTurnRate, a.w)) : 0;
  return { v, w };
}

// ---------- 小车程序注册表 (@名字 快捷方式) ----------
let robotRegistry = null;
function loadRegistry(){
  if (robotRegistry) return robotRegistry;
  try {
    robotRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, 'sim_robots.json'), 'utf8'));
  } catch (e) {
    robotRegistry = {};
  }
  return robotRegistry;
}
// 解析控制器参数: '@名字' → 注册表 cmd; 否则原样返回
function resolveController(spec){
  if (typeof spec === 'string' && spec.startsWith('@')){
    const name = spec.slice(1);
    const entry = loadRegistry()[name];
    if (!entry) throw new Error(`注册表里没有小车程序 '@${name}' — 在 sim_robots.json 里添加, 或用完整命令`);
    return entry.cmd;
  }
  return spec;
}

// ---------- 对战运行器 ----------
// opts: { api, seed, params, scene, vehicles:{us:{...},them:{...}}, dt, maxSteps,
//         us: 'fsm'|cmd|@name, them: 'fsm'|cmd|@name,
//         actionTimeout, traceEvery, realtime, shouldAbort, onLog, onProgress }
async function runBattle(opts){
  const api = opts.api;
  const { resetAll, arm, stepSimExt, getState, getLog, US, THEM } = api;
  const onLog = opts.onLog || (() => {});
  const dt = opts.dt || 0.05;
  const maxSteps = opts.maxSteps || 2400;
  const traceEvery = opts.traceEvery || 20;
  const realtime = opts.realtime !== false;
  const shouldAbort = opts.shouldAbort || (() => false);

  resetAll({ seed: opts.seed, params: opts.params, scene: opts.scene, vehicles: opts.vehicles });
  const usCmd = resolveController(opts.us);
  const themCmd = resolveController(opts.them);
  const usPol  = usCmd  && usCmd  !== 'fsm' ? spawnPolicy(usCmd,  '我方', onLog) : null;
  const themPol = themCmd && themCmd !== 'fsm' ? spawnPolicy(themCmd, '对手', onLog) : null;
  const stopPolicies = () => { if (usPol) usPol.kill(); if (themPol) themPol.kill(); };
  // GUI 后台会话保存这个句柄，使 /battle/stop 能直接终止策略进程，
  // 而不是仅在下一帧规则循环中被动检查 abort 标记。
  if (opts.onPolicies) opts.onPolicies({ stop: stopPolicies });
  arm();

  const trace = [];
  const seen = {
    us: { mounted: false, mountTime: null },
    them: { mounted: false, mountTime: null },
  };
  function observeMilestones(st){
    for (const role of ['us', 'them']){
      const r = st.robots[role];
      if (r.onPlatform && !seen[role].mounted){
        seen[role].mounted = true;
        seen[role].mountTime = +st.simT.toFixed(2);
      }
    }
  }
  const rec = st => trace.push({
    t: +st.simT.toFixed(2),
    scores: st.scores,
    us: { x: +st.robots.us.x.toFixed(3), y: +st.robots.us.y.toFixed(3), th: +st.robots.us.th.toFixed(3), state: st.robots.us.state, action: st.robots.us.action, onPlatform: !!st.robots.us.onPlatform, hang: !!st.robots.us.hang },
    them: { x: +st.robots.them.x.toFixed(3), y: +st.robots.them.y.toFixed(3), th: +st.robots.them.th.toFixed(3), state: st.robots.them.state, action: st.robots.them.action, onPlatform: !!st.robots.them.onPlatform, hang: !!st.robots.them.hang },
  });
  const initialState = getState();
  observeMilestones(initialState);
  rec(initialState);

  let steps = 0;
  for (let i = 0; i < maxSteps; i++){
    if (shouldAbort()) { onLog('[sim] 对战被手动停止'); break; }
    const st = getState();
    if (st.done) break;
    const t0 = Date.now();
    const [au, at] = await Promise.all([
      usPol  ? usPol.ask(mkObs(st, 'us'), opts.actionTimeout) : Promise.resolve(null),
      themPol ? themPol.ask(mkObs(st, 'them'), opts.actionTimeout) : Promise.resolve(null),
    ]);
    stepSimExt(dt, {
      us: usPol ? normAct(au, st.robots.us.vehicle) : null,
      them: themPol ? normAct(at, st.robots.them.vehicle) : null,
    });
    steps = i + 1;
    observeMilestones(getState());
    // 1:1 真实时间节流 (2026-08-12): 实车 FSM 线程按真实时间 50Hz 节流决策，
    // realtime=true 时每帧真实时间 ≥ dt，保证登台时序与实车线程一致；
    // AI 批量搜索可用 realtime=false 跳过等待，保持决策输入/输出协议不变。
    if (realtime){
      const elapsed = Date.now() - t0;
      const need = dt * 1000 - elapsed;
      if (need > 0) await new Promise(r => setTimeout(r, need));
    }
    if (steps % traceEvery === 0) rec(getState());
    if (opts.onProgress && steps % Math.ceil(maxSteps / 10) === 0) opts.onProgress(steps, getState());
  }
  stopPolicies();

  const st = getState();
  return {
    steps,
    simT: st.simT,
    scores: st.scores,
    robots: st.robots,
    done: st.done,
    doneReason: st.doneReason,
    metrics: {
      us: { mounted: seen.us.mounted, mountTime: seen.us.mountTime, finalOnPlatform: !!st.robots.us.onPlatform, finalHang: !!st.robots.us.hang },
      them: { mounted: seen.them.mounted, mountTime: seen.them.mountTime, finalOnPlatform: !!st.robots.them.onPlatform, finalHang: !!st.robots.them.hang },
    },
    trace,
    logTail: getLog().slice(-30),
  };
}

module.exports = { loadCore, createGameEngine, runBattle, mkObs, resolveCmd, resolveController, loadRegistry };
