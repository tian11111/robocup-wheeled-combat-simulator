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
 *   GET   /state          → 全量状态(双车传感器/FSM/比分/日志)
 *   GET   /log            → 事件日志
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadCore, runBattle } = require('./sim_lib');

const PORT = parseInt(process.argv[2] || process.env.SIM_PORT || '8932', 10);
const api = loadCore(__dirname);
const { resetAll, arm, startManual, stepSim, stepSimExt, getState, getLog, setParams, setVehicleFor, getVehicleFor, setPose, setObject, scenePreset, params, scoreBoard,
  beginPreparation, pauseMatch, resumeMatch, restartFor } = api;

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
        core: '3D GameEngine; rules CORE compatibility source',
        endpoints: ['GET /', 'POST /reset', 'POST /arm', 'POST /step', 'POST /step2', 'POST /params', 'GET /vehicle', 'POST /vehicle', 'POST /scene', 'POST /battle/run', 'POST /battle/start', 'POST /battle/stop', 'GET /battle/status', 'GET /state', 'GET /log', 'GET /referee/state', 'POST /referee/pause', 'POST /referee/resume', 'POST /referee/restart'],
        state: getState().robots.us.state,
      });
    }
    if (req.method === 'POST' && u.pathname === '/reset') {
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
