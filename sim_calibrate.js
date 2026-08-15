#!/usr/bin/env node
/*
 * sim_calibrate.js - 由真实遥测拟合决策逻辑仿真的物理参数。
 *
 * 这是离线标定工具：只输出建议值，绝不直接修改 CORE。只有显式传入
 * --update-fidelity 时，才会把拥有足够样本的子系统记录为 calibrated。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FIDELITY_FILE = path.join(ROOT, 'fidelity.json');
const GRAVITY = 9.81;
const BLOCK_LINEAR_DAMPING = 2.2;
const MIN_SAMPLES = Object.freeze({ exponential: 4, block: 4, restitution: 3, stall: 6 });

function fail(message){
  const error = new Error(message);
  error.userMessage = message;
  throw error;
}
function finite(value){ return Number.isFinite(Number(value)) ? Number(value) : null; }
function clamp(value, lo, hi){ return Math.max(lo, Math.min(hi, value)); }
function round(value, digits=6){
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
function sha256(buffer){ return crypto.createHash('sha256').update(buffer).digest('hex'); }
function angleDelta(a, b){
  let delta = b - a;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}
function parseArgs(argv){
  const options = { input: null, out: null, force: false, updateFidelity: false, vehicleId: null };
  for (let i = 0; i < argv.length; i++){
    const arg = argv[i];
    if (arg === '--input') options.input = argv[++i] || null;
    else if (arg === '--out') options.out = argv[++i] || null;
    else if (arg === '--vehicle-id') options.vehicleId = argv[++i] || null;
    else if (arg === '--force') options.force = true;
    else if (arg === '--update-fidelity') options.updateFidelity = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail(`未知参数: ${arg}`);
  }
  return options;
}
function usage(){
  return [
    '用法: node sim_calibrate.js --input telemetry.json [--out calibration/result.json] [--vehicle-id ID] [--update-fidelity] [--force]',
    '',
    '输入必须使用米(m)、秒(s)、弧度(rad)，并带 trials 数组。支持 trial.kind:',
    'lateral_coast、angular_coast、block_push、collision、stall、mount。',
    '详见 SIMULATOR.md 的“真实遥测标定”章节。',
  ].join('\n');
}
function normaliseKind(value){
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    coast: 'lateral_coast', lateral: 'lateral_coast', lateral_coast: 'lateral_coast',
    spin: 'angular_coast', angular: 'angular_coast', angular_coast: 'angular_coast',
    block: 'block_push', block_push: 'block_push', block_slide: 'block_push',
    collision: 'collision', wall_collision: 'collision', head_on_collision: 'collision',
    stall: 'stall', mount: 'mount', climb: 'mount',
  };
  return aliases[key] || key;
}
function normaliseTelemetry(input){
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('遥测根节点必须是 JSON 对象');
  const rawTrials = Array.isArray(input.trials) ? input.trials : (Array.isArray(input.runs) ? input.runs : null);
  if (!rawTrials || !rawTrials.length) fail('遥测必须含非空 trials 数组');
  const trials = rawTrials.map((raw, index) => {
    if (!raw || typeof raw !== 'object') fail(`trials[${index}] 必须是对象`);
    const frames = Array.isArray(raw.frames) ? raw.frames.slice() : [];
    frames.sort((a, b) => Number(a && a.t) - Number(b && b.t));
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex++){
      if (!frames[frameIndex] || typeof frames[frameIndex] !== 'object' || !Number.isFinite(Number(frames[frameIndex].t))){
        fail(`trials[${index}].frames[${frameIndex}].t 必须是秒单位的有限数`);
      }
      if (frameIndex && Number(frames[frameIndex].t) <= Number(frames[frameIndex - 1].t)){
        fail(`trials[${index}] 的时间戳必须严格递增`);
      }
    }
    return { ...raw, id: String(raw.id || `trial-${index + 1}`), kind: normaliseKind(raw.kind || raw.type), frames };
  });
  return { ...input, trials };
}
function poseFrom(frame, key='robot'){
  const source = frame && (frame[key] || (key === 'robot' ? (frame.subject || frame.pose || frame) : null));
  if (!source || typeof source !== 'object') return null;
  const x = finite(source.x), y = finite(source.y), th = finite(source.th);
  if (x === null || y === null) return null;
  // 能量块轨迹不需要朝向；机器人速度/角速度推导必须有 th。
  if (key !== 'block' && th === null) return null;
  return { x, y, th };
}
function vectorFrom(value){
  if (!value || typeof value !== 'object') return null;
  const x = finite(value.vx), y = finite(value.vy);
  return x === null || y === null ? null : { x, y };
}
function velocityIntervals(frames, key='robot'){
  const intervals = [];
  for (let index = 0; index < frames.length - 1; index++){
    const a = poseFrom(frames[index], key);
    const b = poseFrom(frames[index + 1], key);
    const dt = Number(frames[index + 1].t) - Number(frames[index].t);
    if (!a || !b || !(dt > 0)) continue;
    intervals.push({
      index,
      dt,
      t: (Number(frames[index].t) + Number(frames[index + 1].t)) / 2,
      vx: (b.x - a.x) / dt,
      vy: (b.y - a.y) / dt,
      omega: angleDelta(a.th, b.th) / dt,
      th: a.th + angleDelta(a.th, b.th) / 2,
    });
  }
  return intervals;
}
function commandIsIdle(frame, angular=false){
  const command = frame && (frame.command || frame.action || frame.cmd);
  if (!command || typeof command !== 'object') return true;
  const value = finite(angular ? command.w : command.v);
  return value === null || Math.abs(value) <= 0.05;
}
function fitExponentialDecay(trials, mode){
  const pairs = [];
  for (const trial of trials){
    const intervals = velocityIntervals(trial.frames);
    const values = intervals.map((item, index) => {
      if (!commandIsIdle(trial.frames[item.index], mode === 'angular')) return null;
      const speed = mode === 'angular'
        ? item.omega
        : (-item.vx * Math.sin(item.th) + item.vy * Math.cos(item.th));
      return { ...item, index, speed };
    });
    for (let i = 0; i < values.length - 1; i++){
      const a = values[i], b = values[i + 1];
      if (!a || !b || Math.abs(a.speed) < 0.02 || Math.abs(b.speed) < 0.02 || a.speed * b.speed <= 0) continue;
      const dt = b.t - a.t;
      if (!(dt > 0) || dt > 0.5) continue;
      pairs.push({ dt, logRatio: Math.log(Math.abs(b.speed) / Math.abs(a.speed)), trial: trial.id });
    }
  }
  if (pairs.length < MIN_SAMPLES.exponential){
    return insufficient('样本不足', pairs.length, MIN_SAMPLES.exponential);
  }
  const denominator = pairs.reduce((sum, pair) => sum + pair.dt * pair.dt, 0);
  if (!(denominator > 1e-9)) return insufficient('有效时间跨度不足', pairs.length, MIN_SAMPLES.exponential);
  const value = -pairs.reduce((sum, pair) => sum + pair.dt * pair.logRatio, 0) / denominator;
  const rmse = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair.logRatio + value * pair.dt) ** 2, 0) / pairs.length);
  return calibrated(value, pairs.length, { rmse: round(rmse), method: '最小二乘: log(|v(t+dt)|/|v(t)|) = -k·dt' });
}
function blockSpeedIntervals(trial){
  const intervals = [];
  const frames = trial.frames;
  for (let index = 0; index < frames.length - 1; index++){
    const a = poseFrom(frames[index], 'block');
    const b = poseFrom(frames[index + 1], 'block');
    const dt = Number(frames[index + 1].t) - Number(frames[index].t);
    if (!a || !b || !(dt > 0)) continue;
    intervals.push({ index, dt, t: (Number(frames[index].t) + Number(frames[index + 1].t)) / 2, speed: Math.hypot(b.x - a.x, b.y - a.y) / dt });
  }
  return intervals;
}
function fitBlockFriction(trials){
  const pairs = [];
  for (const trial of trials){
    const values = blockSpeedIntervals(trial);
    for (let i = 0; i < values.length - 1; i++){
      const a = values[i], b = values[i + 1];
      if (a.speed < 0.04 || b.speed > a.speed + 0.01) continue;
      const dt = b.t - a.t;
      if (!(dt > 0) || dt > 0.5) continue;
      pairs.push({ before: a.speed, after: b.speed, dt, trial: trial.id });
    }
  }
  if (pairs.length < MIN_SAMPLES.block) return insufficient('样本不足', pairs.length, MIN_SAMPLES.block);
  const loss = mu => pairs.reduce((sum, sample) => {
    const predicted = Math.max(0, sample.before * Math.exp(-BLOCK_LINEAR_DAMPING * sample.dt) - mu * GRAVITY * sample.dt);
    return sum + (sample.after - predicted) ** 2;
  }, 0);
  const value = minimiseBoundedLeastSquares(loss, 0.01, 3);
  const rmse = Math.sqrt(loss(value) / pairs.length);
  return calibrated(value, pairs.length, { rmse: round(rmse), method: '一维最小二乘: v′=max(0,v·exp(-2.2dt)-μgdt)' });
}
function minimiseBoundedLeastSquares(loss, lo, hi){
  let left = lo, right = hi;
  for (let i = 0; i < 80; i++){
    const a = left + (right - left) / 3;
    const b = right - (right - left) / 3;
    if (loss(a) <= loss(b)) right = b;
    else left = a;
  }
  return (left + right) / 2;
}
function normalFromTrial(trial, frame){
  const source = (trial && trial.normal) || (frame && frame.normal);
  if (source && typeof source === 'object'){
    const x = finite(source.x), y = finite(source.y);
    const length = x === null || y === null ? 0 : Math.hypot(x, y);
    if (length > 1e-9) return { x: x / length, y: y / length };
  }
  const wall = String((trial && trial.wall) || '').toLowerCase();
  const wallNormals = { east: { x: 1, y: 0 }, west: { x: -1, y: 0 }, north: { x: 0, y: 1 }, south: { x: 0, y: -1 } };
  if (wallNormals[wall]) return wallNormals[wall];
  const robot = poseFrom(frame, 'robot');
  const opponent = poseFrom(frame, 'opponent');
  if (robot && opponent){
    const length = Math.hypot(opponent.x - robot.x, opponent.y - robot.y);
    if (length > 1e-9) return { x: (opponent.x - robot.x) / length, y: (opponent.y - robot.y) / length };
  }
  return null;
}
function relativeNormalVelocity(value, normal){
  const robot = vectorFrom(value && (value.robot || value.subject || value.a));
  const opponent = vectorFrom(value && (value.opponent || value.other || value.b));
  if (!robot || !normal) return null;
  const other = opponent || { x: 0, y: 0 };
  return (robot.x - other.x) * normal.x + (robot.y - other.y) * normal.y;
}
function collisionSample(trial){
  if (trial.impact && typeof trial.impact === 'object'){
    const normal = normalFromTrial(trial, trial.impact);
    const before = relativeNormalVelocity(trial.impact.pre, normal);
    const after = relativeNormalVelocity(trial.impact.post, normal);
    return before !== null && after !== null ? { before, after } : null;
  }
  const frames = trial.frames;
  if (frames.length < 4) return null;
  let impactIndex = Number.isInteger(trial.impactIndex) ? trial.impactIndex : -1;
  if (impactIndex < 1 || impactIndex > frames.length - 2){
    let nearest = Infinity;
    for (let index = 1; index < frames.length - 1; index++){
      const robot = poseFrom(frames[index], 'robot');
      const opponent = poseFrom(frames[index], 'opponent');
      if (!robot || !opponent) continue;
      const distance = Math.hypot(robot.x - opponent.x, robot.y - opponent.y);
      if (distance < nearest){ nearest = distance; impactIndex = index; }
    }
  }
  if (impactIndex < 1 || impactIndex > frames.length - 2) return null;
  const normal = normalFromTrial(trial, frames[impactIndex]);
  if (!normal) return null;
  const robotIntervals = velocityIntervals(frames, 'robot');
  const opponentIntervals = velocityIntervals(frames, 'opponent');
  const preRobot = robotIntervals.find(item => item.index === impactIndex - 1);
  const postRobot = robotIntervals.find(item => item.index === impactIndex);
  const preOther = opponentIntervals.find(item => item.index === impactIndex - 1) || { vx: 0, vy: 0 };
  const postOther = opponentIntervals.find(item => item.index === impactIndex) || { vx: 0, vy: 0 };
  if (!preRobot || !postRobot) return null;
  const before = (preRobot.vx - preOther.vx) * normal.x + (preRobot.vy - preOther.vy) * normal.y;
  const after = (postRobot.vx - postOther.vx) * normal.x + (postRobot.vy - postOther.vy) * normal.y;
  return { before, after };
}
function fitRestitution(trials){
  const samples = trials.map(collisionSample).filter(sample => sample && sample.before > 0.05 && sample.after <= 0);
  if (samples.length < MIN_SAMPLES.restitution) return insufficient('样本不足或缺失入射法线', samples.length, MIN_SAMPLES.restitution);
  const denominator = samples.reduce((sum, sample) => sum + sample.before ** 2, 0);
  const value = clamp(-samples.reduce((sum, sample) => sum + sample.before * sample.after, 0) / denominator, 0, 0.9);
  const rmse = Math.sqrt(samples.reduce((sum, sample) => sum + (sample.after + value * sample.before) ** 2, 0) / samples.length);
  return calibrated(value, samples.length, { rmse: round(rmse), method: '最小二乘: v_rel,after = -e·v_rel,before' });
}
function frameSpeed(frame){
  const candidates = [frame && frame.actualSpeed, frame && frame.speed, frame && frame.robot && frame.robot.speed];
  for (const value of candidates){ const number = finite(value); if (number !== null) return Math.abs(number); }
  return null;
}
function fitStallSpeed(trials){
  const samples = [];
  for (const trial of trials){
    for (let index = 0; index < trial.frames.length; index++){
      const frame = trial.frames[index];
      const speed = frameSpeed(frame);
      const stalled = frame && (frame.stalled ?? frame.isStalled ?? (frame.robot && frame.robot.isStalled));
      if (speed === null || typeof stalled !== 'boolean') continue;
      const command = frame.command || frame.action || frame.cmd;
      const commanded = !command || finite(command.v) === null || Math.abs(finite(command.v)) > 0.05;
      if (commanded) samples.push({ speed, stalled });
    }
  }
  const positives = samples.filter(sample => sample.stalled).length;
  const negatives = samples.length - positives;
  if (samples.length < MIN_SAMPLES.stall || !positives || !negatives){
    return insufficient('需要至少 6 个带 commanded/stalled 正反标签的速度样本', samples.length, MIN_SAMPLES.stall);
  }
  const values = [...new Set(samples.map(sample => sample.speed))].sort((a, b) => a - b);
  const candidates = [0, ...values];
  for (let index = 0; index < values.length - 1; index++) candidates.push((values[index] + values[index + 1]) / 2);
  let best = null;
  for (const threshold of candidates){
    const squaredError = samples.reduce((sum, sample) => sum + ((sample.speed <= threshold ? 1 : 0) - (sample.stalled ? 1 : 0)) ** 2, 0);
    if (!best || squaredError < best.squaredError || (squaredError === best.squaredError && threshold < best.threshold)) best = { threshold, squaredError };
  }
  const accuracy = 1 - best.squaredError / samples.length;
  return calibrated(best.threshold, samples.length, { rmse: round(Math.sqrt(best.squaredError / samples.length)), accuracy: round(accuracy), method: '阈值二分类最小二乘: isStalled≈[speed≤STALL_SPEED]' });
}
function insufficient(reason, samples, required){ return { calibrated: false, reason, samples, required, value: null }; }
function calibrated(value, samples, meta){ return { calibrated: true, value: round(value), samples, ...meta }; }
function countKinds(trials){
  return trials.reduce((counts, trial) => {
    counts[trial.kind] = (counts[trial.kind] || 0) + 1;
    return counts;
  }, {});
}
function calibrate(rawTelemetry, metadata={}){
  const telemetry = normaliseTelemetry(rawTelemetry);
  const byKind = kind => telemetry.trials.filter(trial => trial.kind === kind);
  const latFrictionK = fitExponentialDecay(byKind('lateral_coast'), 'lateral');
  const angDamping = fitExponentialDecay(byKind('angular_coast'), 'angular');
  const blockMuK = fitBlockFriction(byKind('block_push'));
  const restitution = fitRestitution(byKind('collision'));
  const stallSpeed = fitStallSpeed(byKind('stall'));
  const vehicleId = String(metadata.vehicleId || telemetry.vehicle && telemetry.vehicle.id || telemetry.vehicleId || 'calibrated-vehicle');
  const recommendedVehicle = {};
  const recommendedParams = {};
  if (latFrictionK.calibrated) recommendedVehicle.latFrictionK = latFrictionK.value;
  if (angDamping.calibrated) recommendedVehicle.angDamping = angDamping.value;
  if (blockMuK.calibrated) recommendedParams.BLOCK_MU_K = blockMuK.value;
  if (restitution.calibrated) recommendedParams.COLLISION_RESTITUTION = restitution.value;
  if (stallSpeed.calibrated) recommendedParams.STALL_SPEED = stallSpeed.value;
  const mountTrials = byKind('mount');
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    purpose: '仅决策逻辑仿真参数建议；需要固定 seed 回归和真机复测后才可用于策略结论。',
    telemetry: {
      schemaVersion: telemetry.schemaVersion || null,
      vehicle: telemetry.vehicle || null,
      trialCounts: countKinds(telemetry.trials),
      mountTrials: mountTrials.length,
      capture: telemetry.capture || null,
      ...metadata,
    },
    fits: { latFrictionK, angDamping, BLOCK_MU_K: blockMuK, COLLISION_RESTITUTION: restitution, STALL_SPEED: stallSpeed },
    recommendedPatch: {
      vehicles: Object.keys(recommendedVehicle).length ? { us: { id: vehicleId, ...recommendedVehicle } } : {},
      params: recommendedParams,
    },
    fidelityEligible: {
      friction: latFrictionK.calibrated && blockMuK.calibrated,
      collision: angDamping.calibrated && restitution.calibrated,
      stall: stallSpeed.calibrated,
      mount: false,
    },
    limitations: [
      '登台轨迹会被计数并保留为证据，但本工具不从单次登台直接拟合台阶模型。',
      '无有效样本时字段保持未标定；工具不会猜测或补全参数。',
      '拟合值必须经固定 seed 回归与新一轮真机试验验证，不能直接宣称 meanNetScore 可迁移到真机。',
    ],
  };
}
function readJson(file, description){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${description} 读取失败: ${error.message}`); }
}
function statusLabel(status){
  return ({ calibrated: '已标定', hand_drawn: '手绘', random_stub: '随机桩', uncalibrated: '未标定', verified: '已验证' })[status] || status;
}
function atomicJsonWrite(file, value){
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
function updateFidelity(result, outputRelative, inputHash){
  const fidelity = readJson(FIDELITY_FILE, 'fidelity.json');
  if (!fidelity.subsystems || typeof fidelity.subsystems !== 'object') fail('fidelity.json 缺少 subsystems 对象');
  const updates = [
    ['friction', result.fidelityEligible.friction, ['latFrictionK', 'BLOCK_MU_K']],
    ['collision', result.fidelityEligible.collision, ['angDamping', 'COLLISION_RESTITUTION']],
    ['stall', result.fidelityEligible.stall, ['STALL_SPEED']],
  ];
  const now = new Date().toISOString();
  const updated = [];
  for (const [name, eligible, parameters] of updates){
    if (!eligible) continue;
    fidelity.subsystems[name] = {
      ...fidelity.subsystems[name],
      status: 'calibrated',
      label: statusLabel('calibrated'),
      parameters,
      calibratedAt: now,
      evidence: `sim_calibrate.js: ${outputRelative}；遥测 SHA-256: ${inputHash.slice(0, 16)}。仍需固定 seed 与真机复测。`,
    };
    updated.push(name);
  }
  fidelity.updatedAt = now;
  fidelity.lastCalibration = { output: outputRelative, telemetrySha256: inputHash, updatedSubsystems: updated };
  atomicJsonWrite(FIDELITY_FILE, fidelity);
  return updated;
}
function defaultOutputPath(vehicleId){
  const safeVehicle = String(vehicleId || 'vehicle').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'vehicle';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'calibration', `${safeVehicle}-${stamp}.json`);
}
function runCli(){
  const options = parseArgs(process.argv.slice(2));
  if (options.help){ console.log(usage()); return; }
  if (!options.input) fail('缺少 --input telemetry.json\n\n' + usage());
  const inputPath = path.resolve(process.cwd(), options.input);
  if (!fs.existsSync(inputPath)) fail(`找不到遥测文件: ${inputPath}`);
  const raw = fs.readFileSync(inputPath);
  const telemetry = JSON.parse(raw.toString('utf8'));
  const result = calibrate(telemetry, {
    inputFile: path.basename(inputPath),
    telemetrySha256: sha256(raw),
    vehicleId: options.vehicleId || undefined,
  });
  const vehicleId = result.telemetry.vehicle && result.telemetry.vehicle.id || options.vehicleId || 'vehicle';
  const outputPath = options.out ? path.resolve(process.cwd(), options.out) : defaultOutputPath(vehicleId);
  if (fs.existsSync(outputPath) && !options.force) fail(`输出文件已存在: ${outputPath}（需要覆盖时传 --force）`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  atomicJsonWrite(outputPath, result);
  let updated = [];
  if (options.updateFidelity){
    const relative = path.relative(ROOT, outputPath).replace(/\\/g, '/');
    updated = updateFidelity(result, relative, result.telemetry.telemetrySha256);
  }
  const fitted = Object.entries(result.fits).filter(([, fit]) => fit.calibrated).map(([name, fit]) => `${name}=${fit.value}`).join(', ') || '无（样本不足）';
  console.log(`标定结果: ${fitted}`);
  console.log(`结果文件: ${outputPath}`);
  if (options.updateFidelity) console.log(`保真度已更新: ${updated.length ? updated.join(', ') : '无（没有满足完整标定条件的子系统）'}`);
  else console.log('保真度未改动；确认结果后使用 --update-fidelity 显式登记。');
}

if (require.main === module){
  try { runCli(); }
  catch (error) { console.error(`sim_calibrate: ${error.userMessage || error.message}`); process.exitCode = 1; }
}

module.exports = { calibrate, normaliseTelemetry, fitExponentialDecay, fitBlockFriction, fitRestitution, fitStallSpeed };
