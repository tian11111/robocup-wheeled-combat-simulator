#!/usr/bin/env node
/* ============================================================
 * sim_battle.js — 无头对战 CLI (子进程桥)
 * 任意一方/双方可用"用户自己的小车程序"(子进程), 另一方用内置 FSM。
 *
 * 用法:
 *   node sim_battle.js                              # FSM vs FSM
 *   node sim_battle.js --us "python robot_adapter.py example_robot.py" --them fsm --seed 42
 *   node sim_battle.js --us fsm --them "python robot_adapter.py example_robot.py"
 *
 * 选项:
 *   --us <cmd|fsm>      我方控制器   (默认 fsm)
 *   --them <cmd|fsm>    对手控制器   (默认 fsm)
 *   --seed N            随机种子(可复现)
 *   --dt S              步长(默认 0.05)
 *   --maxsteps N        最大步数(默认 2400 = 2 分钟)
 *   --timeout MS        子进程单步响应超时(默认 300)
 *   --vehicles FILE|JSON  两车参数 profile 文件/JSON ({us:{...},them:{...})
 *   --scene NAME        开局场景预设（如 center）
 *   --auto-mount        仿真辅助：曾上台后掉台自动放回台面（默认关闭）
 *   --external-vision   向外部策略 obs 注入 SimVision/YOLO 视觉结果（默认关闭）
 *   --quiet             只输出结果
 * ============================================================ */
'use strict';
const fs = require('fs');
const { loadCore, runBattle, loadRegistry } = require('./sim_lib');

function arg(name, def){
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}

function readVehicles(raw){
  if (!raw) return undefined;
  const text = fs.existsSync(raw) ? fs.readFileSync(raw, 'utf8') : raw;
  const data = JSON.parse(text);
  const vehicles = data && data.vehicles && typeof data.vehicles === 'object' ? data.vehicles : data;
  if (!vehicles || typeof vehicles !== 'object' || Array.isArray(vehicles)) {
    throw new Error('--vehicles 必须是 {us:{...},them:{...}} 对象或 JSON 文件');
  }
  // 与 sim_runner.py 保持一致：单车 profile 默认作用于我方，
  // 这样 `vehicle_profiles/mbri.json` 可以直接用于本地回放。
  if (!Object.prototype.hasOwnProperty.call(vehicles, 'us') &&
      !Object.prototype.hasOwnProperty.call(vehicles, 'them')) {
    return { us: vehicles };
  }
  return vehicles;
}

// --list: 显示小车程序注册表
if (process.argv.includes('--list')){
  const reg = loadRegistry();
  console.log('== 小车程序注册表 (sim_robots.json) — 用 @名字 引用 ==');
  for (const [k, v] of Object.entries(reg)){
    if (k.startsWith('_')) continue;
    console.log(`  @${k.padEnd(14)} ${v.desc || ''}`);
    console.log(`      cmd: ${v.cmd}`);
  }
  console.log('\n示例: node sim_battle.js --us @example --them fsm --seed 42');
  process.exit(0);
}

const us = arg('us', 'fsm');
const them = arg('them', 'fsm');
const seed = arg('seed', null);
const dt = parseFloat(arg('dt', 0.05));
const maxSteps = parseInt(arg('maxsteps', 2400), 10);
const timeout = parseInt(arg('timeout', 300), 10);
const vehicles = readVehicles(arg('vehicles', null));
const scene = arg('scene', null);
const autoMount = process.argv.includes('--auto-mount');
const externalVision = process.argv.includes('--external-vision');
const quiet = process.argv.includes('--quiet');

(async () => {
  const api = loadCore(__dirname);
  const st0 = api.getState();
  const profileText = vehicles ? `  vehicles=${JSON.stringify(vehicles)}` : '';
  console.log(`== 对战开始 ==  我方: ${us}  对手: ${them}  seed=${seed}  dt=${dt}s  max=${maxSteps}步${profileText}`);
  const onLog = quiet ? () => {} : m => console.log(`  ${m}`);
  const res = await runBattle({
    api, seed: seed === null ? undefined : parseInt(seed, 10),
    dt, maxSteps, us, them, vehicles, scene, autoMount, externalVision, actionTimeout: timeout, onLog,
    onProgress: (steps, st) => console.log(
      `  [${st.simT.toFixed(0)}s] 我方${st.robots.us.state}(${st.robots.us.onPlatform?'台':'下'}) ` +
      `vs 对手${st.robots.them.state}(${st.robots.them.onPlatform?'台':'下'}) | ` +
      `比分 ${st.scores.us}:${st.scores.them}`),
  });
  console.log('== 对战结束 ==');
  console.log(`比分  我方 ${res.scores.us} : ${res.scores.them} 对手`);
  console.log(`用时  ${res.simT.toFixed(1)}s / ${res.steps} 步`);
  console.log(`结果  我方${res.robots.us.state}(${res.robots.us.onPlatform?'台上':'台下'}) ` +
              `对手${res.robots.them.state}(${res.robots.them.onPlatform?'台上':'台下'})`);
  console.log(`原因  ${res.doneReason || '未结束'}`);
  if (res.autoMount && res.autoMount.enabled) console.log(`自动回台  ${JSON.stringify(res.autoMount.counts)}`);
  if (!quiet){
    console.log('--- 事件日志 (尾 15 条) ---');
    for (const e of res.logTail.slice(-15)) console.log(`  [t=${e.t}s] ${e.msg}`);
  }
  process.exit(0);
})().catch(e => { console.error('对战失败:', e); process.exit(1); });
