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

function extractCoreScript(html, source='wushu_ring_sim.html'){
  const begin = html.indexOf('CORE-BEGIN');
  const end = begin < 0 ? -1 : html.indexOf('CORE-END', begin);
  const scriptOpen = begin < 0 ? -1 : html.lastIndexOf('<script', begin);
  const scriptBodyStart = scriptOpen < 0 ? -1 : html.indexOf('>', scriptOpen) + 1;
  const scriptClose = end < 0 ? -1 : html.indexOf('</script>', end);
  if (begin < 0 || end < begin || scriptOpen < 0 || scriptBodyStart <= scriptOpen || scriptClose < end){
    throw new Error(`${source} 中未找到完整 CORE-BEGIN / CORE-END 脚本块`);
  }
  return html.slice(scriptBodyStart, scriptClose);
}
function loadCore(dir){
  const file = path.join(dir, 'wushu_ring_sim.html');
  const html = fs.readFileSync(file, 'utf8');
  const source = extractCoreScript(html, file);
  const moduleShim = { exports: {} };
  new Function('module', source)(moduleShim);
  return moduleShim.exports;
}

// ---------- 子进程策略 ----------
function splitCommand(command){
  const out = [], text = String(command || '');
  let token = '', quote = '';
  const push = () => { if (token) { out.push(token); token = ''; } };
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (quote){
      // Windows 路径的反斜杠是路径分隔符，只有双引号内的 \" / \\ 需要转义。
      if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')){
        token += text[++i];
      } else if (ch === quote) quote = '';
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'"){ quote = ch; continue; }
    if (/\s/.test(ch)){ push(); continue; }
    token += ch;
  }
  if (quote) throw new Error('子进程命令包含未闭合的引号');
  push();
  if (!out.length) throw new Error('子进程命令为空');
  return out;
}
function resolveCmd(cmd){
  const parts = splitCommand(cmd);
  let exe = parts[0];
  if (exe === 'python' || exe === 'python3' || exe === 'py'){
    // 跨平台显式覆盖优先；没有配置时交给系统 PATH / Windows py launcher 解析。
    const configured = String(process.env.SIM_PYTHON || process.env.PYTHON || '').trim();
    if (configured) exe = configured;
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
  const policy = {
    pending: new Map(), alive: true, nextRequestId: 0,
    supportsRequestId: null, legacyQuarantine: null, invalidOutputCount: 0,
    protocolFault: 0, timeoutCount: 0, consecutiveTimeouts: 0,
    maxConsecutiveTimeouts: 8, tripped: false,
  };
  const warnProtocol = message => {
    policy.protocolFault++;
    if (policy.invalidOutputCount++ < 4) onLog(`[${role}子进程] 协议警告: ${message}`);
  };
  const settle = (request, action) => {
    if (!request || request.done) return;
    request.done = true;
    clearTimeout(request.timer);
    policy.pending.delete(request.id);
    request.resolve(action);
  };
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let act = null;
      try { act = JSON.parse(line); } catch (e) { continue; }
      if (!act || Array.isArray(act) || typeof act !== 'object' ||
          !Object.prototype.hasOwnProperty.call(act, 'v') || !Object.prototype.hasOwnProperty.call(act, 'w') ||
          !Number.isFinite(act.v) || !Number.isFinite(act.w)){
        warnProtocol('stdout JSON 必须包含有限数字 v 和 w，已丢弃');
        continue;
      }
      const hasRequestId = act.requestId !== undefined && act.requestId !== null;
      if (hasRequestId){
        policy.supportsRequestId = true;
        const id = String(act.requestId);
        const request = policy.pending.get(id);
        if (request){ policy.consecutiveTimeouts=0; settle(request, { v:act.v, w:act.w }); }
        else {
          if (policy.legacyQuarantine && policy.legacyQuarantine.id === id) policy.legacyQuarantine = null;
          warnProtocol(`收到过期或未知 requestId=${id} 的动作，已丢弃`);
        }
        continue;
      }
      // 已识别为新协议后，未带 requestId 的动作只能是杂乱输出，不能重新回退到旧协议。
      if (policy.supportsRequestId === true){
        warnProtocol('缺少 requestId 的动作，已丢弃');
        continue;
      }
      policy.supportsRequestId = false;
      if (policy.legacyQuarantine){
        policy.legacyQuarantine = null;
        warnProtocol('丢弃超时请求的迟到旧协议动作，已恢复同步');
        continue;
      }
      const request = policy.pending.values().next().value;
      if (request){ policy.consecutiveTimeouts=0; settle(request, { v:act.v, w:act.w }); }
      else warnProtocol('没有等待请求的旧协议动作，已丢弃');
    }
  });
  child.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s) onLog(`[${role}子进程 stderr] ${s.slice(0, 160)}`);
  });
  const closePending = () => {
    policy.legacyQuarantine = null;
    for (const request of [...policy.pending.values()]) settle(request, null);
  };
  child.on('exit', code => { policy.alive = false; closePending(); onLog(`[${role}子进程] 退出 code=${code}`); });
  child.on('error', e => { policy.alive = false; closePending(); onLog(`[${role}子进程] 错误: ${e.message}`); });
  policy.child = child;
  policy.ask = (obs, timeoutMs) => new Promise(resolve => {
    if (!policy.alive) return resolve(null);
    // 对没有 requestId 回包能力的旧程序，超时后先隔离下一帧输入，直到迟到
    // 回包被丢弃；宁可安全停车，也绝不把旧帧动作错配给新观测。
    if (policy.legacyQuarantine) return resolve(null);
    const id = String(++policy.nextRequestId);
    const request = { id, resolve, timer:null, done:false };
    policy.pending.set(id, request);
    request.timer = setTimeout(() => {
      if (!policy.pending.has(id)) return;
      policy.pending.delete(id);
      request.done = true;
      policy.timeoutCount++;
      policy.consecutiveTimeouts++;
      if (policy.supportsRequestId !== true) policy.legacyQuarantine = { id };
      resolve(null);
      if (policy.consecutiveTimeouts >= policy.maxConsecutiveTimeouts && !policy.tripped){
        policy.tripped=true;
        onLog(`[${role}子进程] 连续 ${policy.consecutiveTimeouts} 次超时，已熔断并停车`);
        policy.kill();
      }
    }, timeoutMs || 300);
    try { child.stdin.write(JSON.stringify({ ...obs, requestId:id }) + '\n'); }
    catch (e) { settle(request, null); }
  });
  policy.kill = () => {
    // 取消时立刻释放正在等待子进程动作的 Promise；否则远程“停止”只能
    // 等待 actionTimeout，连续两台车的等待会让下一场启动看似卡死。
    policy.alive = false;
    closePending();
    try { child.kill(); } catch (e) {}
  };
  policy.stats = () => ({
    alive:!!policy.alive, tripped:!!policy.tripped,
    timeoutCount:policy.timeoutCount, consecutiveTimeouts:policy.consecutiveTimeouts,
    protocolFault:policy.protocolFault, invalidOutputCount:policy.invalidOutputCount,
  });
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
// opts: { api, seed, params, scene, fieldGray, vehicles:{us:{...},them:{...}}, dt, maxSteps,
//         us: 'fsm'|cmd|@name, them: 'fsm'|cmd|@name,
//         actionTimeout, traceEvery, realtime, shouldAbort, onLog, onProgress,
//         skipReset }
async function runBattle(opts){
  const api = opts.api;
  const { resetAll, arm, stepSimExt, getState, getLog, US, THEM, onStage } = api;
  const onLog = opts.onLog || (() => {});
  const dt = opts.dt || 0.05;
  const maxSteps = opts.maxSteps || 2400;
  const traceEvery = opts.traceEvery || 20;
  const realtime = opts.realtime !== false;
  const shouldAbort = opts.shouldAbort || (() => false);

  // 后台远程会话需要在 HTTP 响应前先完成一次 reset 以便 GUI 立即看到初始场景；
  // 通过 skipReset 复用该实例，避免 /battle/start 与 runBattle 重复初始化。
  if (!opts.skipReset){
    resetAll({ seed: opts.seed, params: opts.params, scene: opts.scene, fieldGray: opts.fieldGray, vehicles: opts.vehicles });
  }
  const usCmd = resolveController(opts.us);
  const themCmd = resolveController(opts.them);
  const usPol  = usCmd  && usCmd  !== 'fsm' ? spawnPolicy(usCmd,  '我方', onLog) : null;
  const themPol = themCmd && themCmd !== 'fsm' ? spawnPolicy(themCmd, '对手', onLog) : null;
  const stopPolicies = () => { if (usPol) usPol.kill(); if (themPol) themPol.kill(); };
  const policyStats = () => ({ us:usPol ? usPol.stats() : null, them:themPol ? themPol.stats() : null });
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
      const r = st ? st.robots[role] : (role === 'us' ? US : THEM);
      const mounted = st ? r.onPlatform : onStage(r);
      if (mounted && !seen[role].mounted){
        seen[role].mounted = true;
        seen[role].mountTime = +(st ? st.simT : r.fsm.simT).toFixed(2);
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
  const progressEvery = opts.onProgress ? Math.max(1, Math.ceil(maxSteps / 10)) : 0;
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
    // 登台指标只读核心机器人对象，不为每一帧额外创建全量状态快照。
    observeMilestones();
    // 1:1 真实时间节流 (2026-08-12): 实车 FSM 线程按真实时间 50Hz 节流决策，
    // realtime=true 时每帧真实时间 ≥ dt，保证登台时序与实车线程一致；
    // AI 批量搜索可用 realtime=false 跳过等待，保持决策输入/输出协议不变。
    if (realtime){
      const elapsed = Date.now() - t0;
      const need = dt * 1000 - elapsed;
      if (need > 0) await new Promise(r => setTimeout(r, need));
    }
    const needsTrace = steps % traceEvery === 0;
    const needsProgress = progressEvery && steps % progressEvery === 0;
    if (needsTrace || needsProgress){
      const sampled = getState();
      if (needsTrace) rec(sampled);
      if (needsProgress) opts.onProgress(steps, sampled);
    }
  }
  stopPolicies();

  const st = getState();
  const policies = policyStats();
  const warnings=[];
  for(const [role,stats] of Object.entries(policies)) if(stats){
    if(stats.tripped) warnings.push(`${role}:policy_timeout_circuit_breaker`);
    else if(stats.timeoutCount) warnings.push(`${role}:policy_timeout`);
    if(stats.protocolFault) warnings.push(`${role}:policy_protocol_fault`);
  }
  return {
    steps,
    simT: st.simT,
    scores: st.scores,
    robots: st.robots,
    done: st.done,
    doneReason: st.doneReason,
    perception: st.perception,
    policyStats: policies,
    warnings,
    metrics: {
      us: { mounted: seen.us.mounted, mountTime: seen.us.mountTime, finalOnPlatform: !!st.robots.us.onPlatform, finalHang: !!st.robots.us.hang },
      them: { mounted: seen.them.mounted, mountTime: seen.them.mountTime, finalOnPlatform: !!st.robots.them.onPlatform, finalHang: !!st.robots.them.hang },
    },
    trace,
    logTail: getLog().slice(-30),
  };
}

module.exports = { loadCore, extractCoreScript, createGameEngine, runBattle, mkObs, resolveCmd, resolveController, loadRegistry, spawnPolicy, splitCommand };
