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
 *                     "sensorLayout":{类型/位置/朝向}, "perception":{场地灰度/视觉元数据},
 *                     "opponent":{...}, "objects":{...}}
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
function spawnPolicy(cmd, role, onLog, onStderr){
  onStderr = typeof onStderr === 'function' ? onStderr : (() => {});
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
  let resolveStartup, rejectStartup;
  const startup = new Promise((resolve, reject) => {
    resolveStartup = resolve;
    rejectStartup = reject;
  });
  // 直接调用 spawnPolicy 的旧测试/工具可能不读取 ready；挂一个空 catch
  // 避免启动失败时产生未处理 rejection，真正的 runBattle 仍会 await 它。
  startup.catch(() => {});
  const policy = {
    pending: new Map(), alive: true, nextRequestId: 0,
    supportsRequestId: null, legacyQuarantine: null, invalidOutputCount: 0,
    protocolFault: 0, timeoutCount: 0, consecutiveTimeouts: 0,
    maxConsecutiveTimeouts: 8, tripped: false,
    failed: false, failureReason: null, stopping: false,
    started: false, ready: startup,
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
  // stderr 既用于人类可读的短日志，也可由批处理工具按行采集原始诊断。
  // 不改变 stdout 动作协议；按行拆分可避免多个 data chunk 合并时丢失
  // 后续 MBRI_TRACE/用户诊断行。旧调用方不传 onStderr 时行为保持兼容。
  let stderrBuf = '';
  const emitStderrLine = line => {
    const text = String(line || '').trim();
    if (!text) return;
    try { onStderr(role, text); } catch (e) {}
  };
  const flushStderr = () => {
    if (!stderrBuf) return;
    emitStderrLine(stderrBuf);
    stderrBuf = '';
  };
  child.stderr.on('data', d => {
    const raw = d.toString();
    const s = raw.trim();
    if (s) onLog(`[${role}子进程 stderr] ${s.slice(0, 160)}`);
    stderrBuf += raw;
    let i;
    while ((i = stderrBuf.indexOf('\n')) >= 0){
      emitStderrLine(stderrBuf.slice(0, i));
      stderrBuf = stderrBuf.slice(i + 1);
    }
  });
  child.once('spawn', () => {
    policy.started = true;
    resolveStartup();
  });
  const closePending = () => {
    policy.legacyQuarantine = null;
    for (const request of [...policy.pending.values()]) settle(request, null);
  };
  child.on('exit', code => {
    flushStderr();
    policy.alive = false;
    if(!policy.stopping){
      policy.failed = true;
      policy.failureReason = `子进程意外退出 code=${code}`;
    }
    if(!policy.started) rejectStartup(new Error(`runner_error/policy_process: ${policy.failureReason || `子进程退出 code=${code}`}`));
    closePending();
    onLog(`[${role}子进程] 退出 code=${code}`);
  });
  child.on('error', e => {
    policy.alive = false;
    if(!policy.stopping){
      policy.failed = true;
      policy.failureReason = `子进程错误: ${e.message}`;
    }
    if(!policy.started) rejectStartup(new Error(`runner_error/policy_process: ${policy.failureReason || e.message}`));
    closePending();
    onLog(`[${role}子进程] 错误: ${e.message}`);
  });
  policy.child = child;
  policy.ask = (obs, timeoutMs) => new Promise((resolve, reject) => {
    if (!policy.alive){
      if(policy.failed) return reject(new Error(`runner_error/policy_process: ${policy.failureReason}`));
      return resolve(null);
    }
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
    policy.stopping = true;
    policy.alive = false;
    closePending();
    try { child.kill(); } catch (e) {}
  };
  policy.stats = () => ({
    alive:!!policy.alive, tripped:!!policy.tripped,
    timeoutCount:policy.timeoutCount, consecutiveTimeouts:policy.consecutiveTimeouts,
    protocolFault:policy.protocolFault, invalidOutputCount:policy.invalidOutputCount,
    failed:!!policy.failed, failureReason:policy.failureReason,
  });
  return policy;
}

// ---------- 观测构造 ----------
function perceptionForRole(st, role, vision){
  if(!vision) return st.perception;
  const base=st && st.perception && typeof st.perception==='object' ? st.perception : {};
  const baseVision=base.vision && typeof base.vision==='object' ? base.vision : {};
  const baseExternal=baseVision.external && typeof baseVision.external==='object' ? baseVision.external : {};
  const roles=baseExternal.roles && typeof baseExternal.roles==='object' ? {...baseExternal.roles} : {};
  roles[role]={...(roles[role]||{}),...vision};
  return {
    ...base,
    vision:{
      ...baseVision,
      external:{...baseExternal,roles},
    },
  };
}
function mkObs(st, role, vision){
  const r = st.robots[role];
  return {
    t: st.simT, role, timer: st.timer, scores: st.scores,
    match: st.match,
    robot: r,
    sensors: st.sensors[role],
    rawSensors: st.rawSensors ? st.rawSensors[role] : st.sensors[role],
    sensorCompat: st.sensorCompat ? st.sensorCompat[role] : st.sensors[role],
    sensorLayout: st.sensorLayout ? st.sensorLayout[role] : undefined,
    // 视觉仍由 CORE 的 classifyRate / 外部缓存决定；把元数据传给适配器，
    // 不把 objects 类型注入视觉结果，保持“传感器接口不泄漏答案”的约束。
    // 外部策略视觉是显式可选桥接；未开启时保持原 perception 引用和确定性轨迹。
    perception: perceptionForRole(st, role, vision),
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
function traceNumber(value, digits=4){
  const n=Number(value);
  return Number.isFinite(n) ? +n.toFixed(digits) : 0;
}
function traceAction(action){
  if(!action || typeof action!=='object') return null;
  return { v:traceNumber(action.v), w:traceNumber(action.w) };
}
function traceRobot(st, role, requested, detailed=true){
  const r=st && st.robots && st.robots[role] ? st.robots[role] : {};
  const command=r.command || {};
  const applied=command.applied || {v:r.cmdV ?? r.v, w:r.cmdW ?? r.w};
  const heading=Number(r.th)||0;
  const vx=Number(r.vx)||0, vy=Number(r.vy)||0;
  const actualV=vx*Math.cos(heading)+vy*Math.sin(heading);
  const out={
    // 保留旧 trace 的平铺字段，新增诊断字段不破坏已有消费者。
    x:traceNumber(r.x,3), y:traceNumber(r.y,3), th:traceNumber(r.th,3),
    state:r.state || '', action:r.action || '', onPlatform:!!r.onPlatform, hang:!!r.hang,
  };
  if(!detailed) return out;
  Object.assign(out,{
    pose:{x:traceNumber(r.x),y:traceNumber(r.y),th:traceNumber(r.th),pitch:traceNumber(r.pitch),roll:traceNumber(r.roll),zG:traceNumber(r.zG)},
    // velocity 是积分后的实际运动；控制器请求/延迟后的电机指令单独放在 actions。
    velocity:{v:traceNumber(actualV),w:traceNumber(r.omega),speed:traceNumber(Math.hypot(vx,vy)),omega:traceNumber(r.omega)},
    actions:{requested:traceAction(requested),applied:traceAction(applied)},
    flags:{isStalled:!!r.isStalled,wedgedFront:!!r.wedgedFront,frontLoad:traceNumber(r.frontLoad,3)},
    sensors:st.sensors && st.sensors[role] ? st.sensors[role] : {},
    rawSensors:st.rawSensors && st.rawSensors[role] ? st.rawSensors[role] : {},
  });
  return out;
}
function traceEventList(events){
  return (Array.isArray(events) ? events : []).map(e=>({
    seq:Number.isFinite(Number(e && e.seq)) ? Number(e.seq) : null,
    t:traceNumber(e && e.t,2), msg:String(e && e.msg || ''), cls:String(e && e.cls || ''),
  }));
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
// sim_server.js 会在服务运行期间写入 sim_robots.json（上传/导入小车程序）。
// 写入后清掉模块缓存，保证同一服务进程下一场对战能立即解析新 @名字。
function invalidateRegistry(){
  robotRegistry = null;
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
//         actionTimeout, traceEvery, includeTrace, realtime, externalVision, shouldAbort, onLog, onProgress,
//         skipReset, autoMount?, autoMountRoles?, autoMountPose? }
async function runBattle(opts){
  const api = opts.api;
  const { resetAll, arm, stepSimExt, getState, getLog, setPoseFor, logFor, US, THEM, onStage, hangOn } = api;
  const onLog = opts.onLog || (() => {});
  const dt = opts.dt || 0.05;
  const maxSteps = opts.maxSteps || 2400;
  const traceEvery = opts.traceEvery || 20;
  const realtime = opts.realtime !== false;
  const includeTrace = opts.includeTrace === true;
  const externalVision = opts.externalVision === true && typeof api.getExternalVisionFor === 'function';
  const shouldAbort = opts.shouldAbort || (() => false);
  // 仅用于“策略逻辑/日志”回放的安全辅助：默认关闭，且只自动回台曾经
  // 上台后掉台的车辆。它不改变 CORE 的掉台判定、计分或 MBri 状态机。
  const autoMountEnabled = opts.autoMount === true;
  const autoMountRoles = new Set(
    Array.isArray(opts.autoMountRoles) && opts.autoMountRoles.length
      ? opts.autoMountRoles.filter(role => role === 'us' || role === 'them')
      : ['us']
  );
  const autoMountPose = opts.autoMountPose && typeof opts.autoMountPose === 'object'
    ? opts.autoMountPose : {};
  const autoMountCounts = { us:0, them:0 };

  // 后台远程会话需要在 HTTP 响应前先完成一次 reset 以便 GUI 立即看到初始场景；
  // 通过 skipReset 复用该实例，避免 /battle/start 与 runBattle 重复初始化。
  if (!opts.skipReset){
    resetAll({ seed: opts.seed, params: opts.params, scene: opts.scene, fieldGray: opts.fieldGray, vehicles: opts.vehicles });
  }
  const usCmd = resolveController(opts.us);
  const themCmd = resolveController(opts.them);
  // 外部策略启动失败不能静默退回内置 FSM，否则评测对象根本没有运行。
  let usPol = null, themPol = null;
  try {
    usPol = usCmd && usCmd !== 'fsm' ? spawnPolicy(usCmd, '我方', onLog, opts.onPolicyStderr) : null;
    if (usCmd && usCmd !== 'fsm' && !usPol) throw new Error('runner_error/policy_spawn: 我方策略子进程启动失败');
    themPol = themCmd && themCmd !== 'fsm' ? spawnPolicy(themCmd, '对手', onLog, opts.onPolicyStderr) : null;
    if (themCmd && themCmd !== 'fsm' && !themPol) throw new Error('runner_error/policy_spawn: 对手策略子进程启动失败');
    const startupPolicies = [usPol, themPol].filter(Boolean);
    if (startupPolicies.length){
      await Promise.all(startupPolicies.map(policy => policy.ready));
      // 让已 spawn 但立即退出的子进程先派发 exit 事件，短评测也能
      // 在第一帧前识别 runner_error，而不是误记成零动作。
      await new Promise(resolve => setImmediate(resolve));
      for (const [role, policy] of [['us', usPol], ['them', themPol]]){
        if (policy && policy.failed){
          throw new Error(`runner_error/policy_process: ${role} ${policy.failureReason || '策略进程不可用'}`);
        }
      }
    }
  } catch (e) {
    if (usPol) usPol.kill();
    if (themPol) themPol.kill();
    throw e;
  }
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
  const diagnostics = {
    stateTransitions: { us: 0, them: 0 },
    falls: [],
    lastState: { us: null, them: null },
    lastMounted: { us: false, them: false },
    eventCount: 0,
    eventClasses: {},
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
  function observeDiagnostics(){
    for(const role of ['us','them']){
      const r=role==='us'?US:THEM;
      const state=r.fsm.state;
      const mounted=!!onStage(r);
      if(diagnostics.lastState[role]!==null && diagnostics.lastState[role]!==state)
        diagnostics.stateTransitions[role]++;
      if(diagnostics.lastMounted[role] && !mounted){
        diagnostics.falls.push({role,t:traceNumber(r.fsm.simT,2),state});
      }
      diagnostics.lastState[role]=state;
      diagnostics.lastMounted[role]=mounted;
    }
  }
  function autoMountDropped(){
    if(!autoMountEnabled || typeof setPoseFor !== 'function') return [];
    const mounted=[];
    for(const role of autoMountRoles){
      const r=role==='us'?US:THEM;
      if(!seen[role].mounted || onStage(r) || r.fsm.state==='DONE') continue;
      const requested=autoMountPose[role] && typeof autoMountPose[role]==='object'
        ? autoMountPose[role] : {};
      const fallback = role==='us' ? {x:1.55,y:1.90,th:0} : {x:2.25,y:1.90,th:Math.PI};
      const x=Number.isFinite(Number(requested.x)) ? Number(requested.x) : fallback.x;
      const y=Number.isFinite(Number(requested.y)) ? Number(requested.y) : fallback.y;
      const th=Number.isFinite(Number(requested.th)) ? Number(requested.th) : fallback.th;
      setPoseFor(r,x,y,th);
      r.wasOn=true; r.dropPending=false;
      autoMountCounts[role]++;
      mounted.push(role);
      if(typeof logFor==='function') logFor(r, `[sim] 自动回台(${autoMountCounts[role]})`, 'sim');
    }
    return mounted;
  }
  let traceLogCursor=0;
  let traceScores={us:0,them:0};
  const eventLog=[];
  function takeTraceEvents(){
    if(!includeTrace) return [];
    const all=getLog();
    const hasSequence=all.some(event=>Number.isFinite(Number(event && event.seq)));
    const fresh=hasSequence
      ? all.filter(event=>Number(event && event.seq)>traceLogCursor)
      : (traceLogCursor>all.length ? all : all.slice(traceLogCursor));
    const events=traceEventList(fresh);
    if(events.length){
      const latest=events[events.length-1].seq;
      traceLogCursor=Number.isFinite(latest) ? latest : all.length;
    } else if(!hasSequence) {
      traceLogCursor=all.length;
    }
    if(events.length){
      eventLog.push(...events);
      diagnostics.eventCount += events.length;
      for(const event of events){
        const cls=event.cls || 'info';
        diagnostics.eventClasses[cls]=(diagnostics.eventClasses[cls]||0)+1;
      }
    }
    return events;
  }
  const rec = (st, requested, step) => {
    const scoreDelta={
      us:Number(st.scores.us||0)-traceScores.us,
      them:Number(st.scores.them||0)-traceScores.them,
    };
    traceScores={us:Number(st.scores.us||0),them:Number(st.scores.them||0)};
    const entry={
      step,
      t: +st.simT.toFixed(2),
      scores: st.scores,
      us: traceRobot(st,'us',requested && requested.us,includeTrace),
      them: traceRobot(st,'them',requested && requested.them,includeTrace),
    };
    if(includeTrace){
      entry.match=st.match;
      entry.reward={...scoreDelta,total:scoreDelta.us-scoreDelta.them};
      entry.objects=st.objects;
      entry.events=takeTraceEvents();
    }
    trace.push(entry);
  };
  const initialState = getState();
  observeMilestones(initialState);
  diagnostics.lastState.us=initialState.robots.us.state;
  diagnostics.lastState.them=initialState.robots.them.state;
  diagnostics.lastMounted.us=!!initialState.robots.us.onPlatform;
  diagnostics.lastMounted.them=!!initialState.robots.them.onPlatform;
  rec(initialState,null,0);

  let steps = 0;
  let lastRequested = { us:null, them:null };
  const progressEvery = opts.onProgress ? Math.max(1, Math.ceil(maxSteps / 10)) : 0;
  try {
    for (let i = 0; i < maxSteps; i++){
      if (shouldAbort()) { onLog('[sim] 对战被手动停止'); break; }
      const st = getState();
      if (st.done) break;
      const t0 = Date.now();
      const frameId=steps+1;
      const vision={
        us:externalVision ? api.getExternalVisionFor('us', `us-${frameId}`) : null,
        them:externalVision ? api.getExternalVisionFor('them', `them-${frameId}`) : null,
      };
      const [au, at] = await Promise.all([
        usPol  ? usPol.ask(mkObs(st, 'us', vision.us), opts.actionTimeout) : Promise.resolve(null),
        themPol ? themPol.ask(mkObs(st, 'them', vision.them), opts.actionTimeout) : Promise.resolve(null),
      ]);
      for(const [role, policy] of [['us', usPol], ['them', themPol]]){
        if(policy && policy.failed){
          throw new Error(`runner_error/policy_process: ${role} ${policy.failureReason || '策略进程不可用'}`);
        }
      }
      // normAct 是“请求动作”的边界：记录限幅后的请求，同时把超时/退出
      // 明确转换成零动作，不能让 null 落回内置 FSM 或沿用上一帧速度。
      const requested = {
        us: usPol ? normAct(au, st.robots.us.vehicle) : null,
        them: themPol ? normAct(at, st.robots.them.vehicle) : null,
      };
      lastRequested = requested;
      const control = {
        us: usPol ? (requested.us || {v:0, w:0}) : null,
        them: themPol ? (requested.them || {v:0, w:0}) : null,
      };
      stepSimExt(dt, {
        us: control.us,
        them: control.them,
      });
      steps = i + 1;
      // 登台指标只读核心机器人对象，不为每一帧额外创建全量状态快照。
      observeMilestones();
      observeDiagnostics();
      autoMountDropped();
      // 自动回台后更新里程碑，但不覆盖上一步已经记录的掉台诊断。
      if(autoMountEnabled) observeMilestones();
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
        if (needsTrace) rec(sampled, requested, steps);
        if (needsProgress) opts.onProgress(steps, sampled);
      }
    }
  } finally {
    // 无论策略正常结束、超时熔断、异常退出还是调用方取消，都必须回收
    // 两侧子进程；否则下一场评测会残留进程并长期占用 IPC/端口。
    stopPolicies();
  }

  const st = getState();
  observeDiagnostics();
  if(includeTrace){
    const lastTrace = trace[trace.length-1];
    if(lastTrace && lastTrace.step===steps){
      lastTrace.events.push(...takeTraceEvents());
    } else {
      // 诊断模式总是保留最终状态，即使最后一步不落在 traceEvery 采样点上。
      rec(st, lastRequested, steps);
    }
  }
  const policies = policyStats();
  // 最后一个积分步可能尚未让核心写入 FINISHED；运行器统一收敛时间到期语义。
  const reachedLimit = !st.done && steps >= maxSteps && !shouldAbort();
  const simTimeLimit = reachedLimit && Number(st.simT) >= 120 - 1e-9;
  const outputDone = !!st.done || reachedLimit;
  const outputDoneReason = st.doneReason || (simTimeLimit ? '比赛时间结束' : (reachedLimit ? '达到 maxSteps' : ''));
  const firstFall = diagnostics.falls.length ? diagnostics.falls[0] : null;
  const lastFall = diagnostics.falls.length ? diagnostics.falls[diagnostics.falls.length-1] : null;
  const finalOffRoles = ['us','them'].filter(role =>
    !!seen[role].mounted && !st.robots[role].onPlatform
  );
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
    done: outputDone,
    doneReason: outputDoneReason,
    perception: st.perception,
    policyStats: policies,
    warnings,
    autoMount: { enabled:autoMountEnabled, roles:[...autoMountRoles], counts:{...autoMountCounts} },
    metrics: {
      us: { mounted: seen.us.mounted, mountTime: seen.us.mountTime, finalOnPlatform: !!st.robots.us.onPlatform, finalHang: !!st.robots.us.hang },
      them: { mounted: seen.them.mounted, mountTime: seen.them.mountTime, finalOnPlatform: !!st.robots.them.onPlatform, finalHang: !!st.robots.them.hang },
    },
    trace,
    logTail: getLog().slice(-30),
    ...(includeTrace ? {
      events: eventLog,
      traceFormat: 'diagnostic-v1',
      traceMeta: {
        dt,
        traceEvery,
        maxSteps,
        fields: ['match','scores','reward','pose','velocity','actions','flags','sensors','rawSensors','objects','events'],
      },
    } : {}),
    diagnostics: {
      format: includeTrace ? 'diagnostic-v1' : 'summary-v1',
      termination: {
        done: outputDone,
        doneReason: outputDoneReason,
        steps,
        maxSteps,
        stepLimitHit: reachedLimit,
        aborted: !!shouldAbort(),
      },
      milestones: seen,
      stateTransitions: diagnostics.stateTransitions,
      finalState: diagnostics.lastState,
      falls: diagnostics.falls,
      fallSummary: {
        firstFall,
        lastFall,
        recoveredAfterFall: !!lastFall && finalOffRoles.length===0,
        unrecoveredFall: finalOffRoles.length>0,
        finalOffRoles,
      },
      events: {
        recorded: includeTrace,
        count: includeTrace ? diagnostics.eventCount : null,
        classes: includeTrace ? diagnostics.eventClasses : null,
      },
      failure: (() => {
        const policyRole = Object.entries(policies).find(([, stats]) => stats && stats.tripped);
        if(policyRole) return { category:'policy_timeout', role:policyRole[0], time:st.simT, reason:'连续动作超时触发熔断', state:st.robots[policyRole[0]].state };
        const timeoutRole = Object.entries(policies).find(([, stats]) => stats && stats.timeoutCount);
        if(timeoutRole) return { category:'policy_timeout', role:timeoutRole[0], time:st.simT, reason:'策略动作响应超时', state:st.robots[timeoutRole[0]].state };
        const protocolRole = Object.entries(policies).find(([, stats]) => stats && stats.protocolFault);
        if(protocolRole) return { category:'policy_protocol', role:protocolRole[0], time:st.simT, reason:'策略 stdout 协议错误', state:st.robots[protocolRole[0]].state };
        if(/登台失败|恢复次数超限/.test(String(st.doneReason||''))){
          const role=st.robots.us.state==='FINISHED' ? 'us' : (st.robots.them.state==='FINISHED' ? 'them' : null);
          return { category:'mount_failed', role, time:st.simT, reason:st.doneReason, state:role ? st.robots[role].state : null };
        }
        if(finalOffRoles.length && lastFall){
          return { category:'fell', role:lastFall.role, time:lastFall.t, reason:'车辆最终未回到擂台 footprint', state:lastFall.state };
        }
        if(outputDoneReason && /比赛时间结束/.test(String(outputDoneReason)))
          return { category:'time_limit', role:null, time:st.simT, reason:outputDoneReason, state:null };
        if(reachedLimit)
          return { category:'time_limit', role:null, time:st.simT, reason:'达到 maxSteps', state:null };
        if(!st.done && shouldAbort())
          return { category:'cancelled', role:null, time:st.simT, reason:'调用方请求停止', state:null };
        if(!st.done)
          return { category:'unfinished', role:null, time:st.simT, reason:'循环结束时比赛尚未完成', state:null };
        return null;
      })(),
    },
  };
}

module.exports = { loadCore, extractCoreScript, createGameEngine, runBattle, mkObs, resolveCmd, resolveController, loadRegistry, invalidateRegistry, spawnPolicy, splitCommand };
