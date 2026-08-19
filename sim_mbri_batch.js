#!/usr/bin/env node
/*
 * sim_mbri_batch.js — MBri 仿真回归批处理
 *
 * 这是仿真器侧的实验工具：不改 MBri 源码。默认从台面中心开始，
 * 对 US 开启 simulation-only autoMount（曾上台后掉台自动放回台面），
 * 用固定 seed 跑 10 组并把完整 diagnostic-v1 轨迹落盘。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadCore, runBattle } = require('./sim_lib');

const DEFAULT_SEEDS = [42, 7, 21, 100, 123, 9, 17, 33, 77, 88];
const root = __dirname;

function arg(name, fallback){
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
function parseSeeds(raw){
  if (!raw) return [...DEFAULT_SEEDS];
  const seeds = String(raw).split(',').map(v => Number(v.trim())).filter(Number.isInteger);
  if (!seeds.length || seeds.some(v => v < 0) || new Set(seeds).size !== seeds.length)
    throw new Error('--seeds 必须是互不重复的非负整数，例如 42,7,21');
  return seeds;
}
function safeNumber(value, fallback){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function utcName(){
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function csvCell(value){
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseMbriTraceLine(role, line, trace, errors){
  if (role !== '我方') return;
  const match = /^MBRI_TRACE\s+(\{[\s\S]*\})$/.exec(String(line || '').trim());
  if (!match) return;
  try {
    const event = JSON.parse(match[1]);
    if (event && typeof event === 'object') trace.push(event);
  } catch (error) {
    errors.push({ line: String(line || '').slice(0, 500), error: String(error.message || error) });
  }
}

function summarizeMbriTrace(trace){
  const list = Array.isArray(trace) ? trace : [];
  const stateCounts = {}, modeCounts = {}, patrolCounts = {}, reentryCounts = {};
  const visionTypeCounts = {}, visionLabelCounts = {}, visionSourceCounts = {};
  const transitions = [];
  let previous = null;
  let leftMin = Infinity, leftMax = -Infinity, rightMin = Infinity, rightMax = -Infinity;
  let zeroCommand = 0;
  for (const event of list){
    for (const [key, counts] of [['state', stateCounts], ['mode', modeCounts], ['patrol', patrolCounts], ['reentry', reentryCounts]]){
      const value = String(event[key] || '');
      if (value) counts[value] = (counts[value] || 0) + 1;
    }
    const vision=event.vision && typeof event.vision==='object' ? event.vision : {};
    for(const [key, counts] of [['type', visionTypeCounts], ['label', visionLabelCounts], ['source', visionSourceCounts]]){
      const value=String(vision[key]||'');
      if(value) counts[value]=(counts[value]||0)+1;
    }
    const left = Number(event.l), right = Number(event.r);
    if (Number.isFinite(left)){ leftMin = Math.min(leftMin, left); leftMax = Math.max(leftMax, left); }
    if (Number.isFinite(right)){ rightMin = Math.min(rightMin, right); rightMax = Math.max(rightMax, right); }
    if (Math.abs(left || 0) < 1 && Math.abs(right || 0) < 1) zeroCommand++;
    const signature = ['state', 'mode', 'patrol', 'reentry', 'hunt', 'probe']
      .map(key => `${key}=${String(event[key] || '')}`).join('|');
    if (previous && previous.signature !== signature){
      transitions.push({ t: event.t, from: previous.signature, to: signature });
    }
    previous = { signature };
  }
  const finite = value => Number.isFinite(value) ? value : null;
  return {
    samples: list.length,
    firstT: list.length ? list[0].t : null,
    lastT: list.length ? list[list.length - 1].t : null,
    stateCounts, modeCounts, patrolCounts, reentryCounts,
    visionTypeCounts, visionLabelCounts, visionSourceCounts,
    transitions,
    command: {
      leftMin: finite(leftMin), leftMax: finite(leftMax),
      rightMin: finite(rightMin), rightMax: finite(rightMax),
      zeroRatio: list.length ? zeroCommand / list.length : null,
    },
  };
}

function nearestByTime(list, t){
  const values = Array.isArray(list) ? list : [];
  if (!values.length || !Number.isFinite(Number(t))) return null;
  return values.reduce((best, value) => {
    if (!best) return value;
    return Math.abs(Number(value.t) - Number(t)) < Math.abs(Number(best.t) - Number(t)) ? value : best;
  }, null);
}

function fallContexts(run, mbriTrace){
  const falls = run && run.diagnostics && Array.isArray(run.diagnostics.falls)
    ? run.diagnostics.falls : [];
  return falls.map(fall => {
    const sample = nearestByTime(run.trace, fall.t);
    const mbri = fall.role === 'us' ? nearestByTime(mbriTrace, fall.t) : null;
    const robot = sample && sample[fall.role] ? sample[fall.role] : null;
    return {
      role: fall.role,
      t: fall.t,
      state: fall.state,
      mbri: mbri ? {
        t: mbri.t, state: mbri.state, mode: mbri.mode, patrol: mbri.patrol,
        reentry: mbri.reentry, hunt: mbri.hunt, probe: mbri.probe,
        l: mbri.l, r: mbri.r,
      } : null,
      robot: robot ? {
        t: sample.t, x: robot.x, y: robot.y, th: robot.th, onPlatform: robot.onPlatform,
        rawSensors: robot.rawSensors || {}, actions: robot.actions || {},
        velocity: robot.velocity || {}, flags: robot.flags || {},
      } : null,
    };
  });
}

function makeAnalysis(summary, runs){
  const lines = [
    '# MBri 10 组仿真诊断',
    '',
    `- 成功：${summary.success}/${summary.total}`,
    `- 平均我方得分：${summary.meanUsScore == null ? '无' : summary.meanUsScore.toFixed(2)}`,
    `- 平均对方得分：${summary.meanThemScore == null ? '无' : summary.meanThemScore.toFixed(2)}`,
    `- 平均净胜分：${summary.meanNetScore == null ? '无' : (summary.meanNetScore >= 0 ? '+' : '') + summary.meanNetScore.toFixed(2)}`,
    `- 我方胜率：${summary.usWinRate == null ? '无' : (summary.usWinRate * 100).toFixed(1) + '%'}`,
    `- 自动回台次数：${summary.autoMounts}`,
    `- 策略超时/协议错误：${summary.timeoutCount}/${summary.protocolFaults}`,
    '',
    '## 每局摘要',
    '',
    '| seed | 净分 | 我方掉台 | 对手掉台 | 自动回台 | MBri 样本 | 状态/模式 |',
    '|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const run of runs){
    const scores = run.scores || {};
    const net = run.ok ? Number(scores.us || 0) - Number(scores.them || 0) : null;
    const contexts = Array.isArray(run.fallContexts) ? run.fallContexts : [];
    const usFalls = contexts.filter(item => item.role === 'us').length;
    const themFalls = contexts.filter(item => item.role === 'them').length;
    const states = run.mbriTraceSummary && Object.keys(run.mbriTraceSummary.stateCounts || {}).join(', ') || '无诊断';
    const modes = run.mbriTraceSummary && Object.keys(run.mbriTraceSummary.modeCounts || {}).join(', ') || '无诊断';
    lines.push(`| ${run.seed} | ${net == null ? '失败' : (net >= 0 ? '+' : '') + net} | ${usFalls} | ${themFalls} | ${run.autoMount && run.autoMount.counts ? run.autoMount.counts.us : 0} | ${run.mbriTraceSummary ? run.mbriTraceSummary.samples : 0} | ${states} / ${modes} |`);
  }
  lines.push('', '## 自动分析提示', '');
  const totalTransitions = runs.reduce((sum, run) => sum + Number(run.mbriTraceSummary && run.mbriTraceSummary.transitions && run.mbriTraceSummary.transitions.length || 0), 0);
  lines.push(`- 共记录 ${totalTransitions} 次 MBri 内部状态/模式组合变化；完整逐帧记录见 mbri-trace.jsonl 和各局的 result.json。`);
  if (summary.autoMounts) lines.push('- 自动回台发生过：掉台判定和裁判计分仍然生效，回台只是仿真侧辅助，不能当作 MBri 自己完成了登台。');
  if (summary.timeoutCount === 0 && summary.protocolFaults === 0) lines.push('- 没有观察到策略 IPC 超时或协议错误，动作链路稳定。');
  const usFallContexts = runs.flatMap(run => (run.fallContexts || []).filter(item => item.role === 'us'));
  const edgeAvoidFalls = usFallContexts.filter(item => /EDGE_AVOID|EDGE_TURN/.test(String(item.mbri && item.mbri.state || ''))).length;
  const forwardRecoverFalls = usFallContexts.filter(item => /RECOVER_FORWARD/.test(String(item.mbri && item.mbri.state || ''))).length;
  if (usFallContexts.length){
    lines.push(`- 我方掉台上下文 ${usFallContexts.length} 次：其中 ${edgeAvoidFalls} 次发生在 EDGE_AVOID/EDGE_TURN，${forwardRecoverFalls} 次发生在 RECOVER_FORWARD；这两类应优先检查灰度标定、传感器延迟和动作生效时序。`);
  }
  const negativeRuns = runs.filter(run => run.ok && Number(run.scores && run.scores.us || 0) < Number(run.scores && run.scores.them || 0));
  if (negativeRuns.length){
    lines.push(`- 重点复核净分为负的 seed：${negativeRuns.map(run => run.seed).join(', ')}；比较掉台时刻、MBri 状态转移和掉台前最后 2 秒的灰度/红外读数，再决定是否调整适配标定。`);
  } else {
    lines.push('- 本批次没有净分为负的 seed，但这不等于真机胜率；本批次启用了仿真辅助 autoMount，且灰度/摩擦/视觉仍未完成真机标定。');
  }
  if (summary.visionGoodFrames === 0 && summary.visionBadFrames === 0){
    lines.push('- 逐帧 MBRI_TRACE 中 good/bad 均为 0：本批次没有外部 YOLO 检测结果，不能用这 10 局评价 MBri 的视觉识别能力。');
  } else {
    const labels={};
    for(const run of runs){
      for(const [label,count] of Object.entries(run.mbriTraceSummary && run.mbriTraceSummary.visionLabelCounts || {})) labels[label]=(labels[label]||0)+count;
    }
    lines.push(`- 视觉桥已生效：good=${summary.visionGoodFrames} 帧、bad=${summary.visionBadFrames} 帧；标签来源统计 ${JSON.stringify(labels)}。`);
  }
  return `${lines.join('\n')}\n`;
}

async function main(){
  if (!process.env.MBRI_ROOT) throw new Error('MBRI_ROOT 未设置，请先指向 MBri 项目根目录');
  const seeds = parseSeeds(arg('seeds', null));
  const maxSteps = Math.max(1, Math.floor(safeNumber(arg('maxsteps', 600), 600)));
  const traceEvery = Math.max(1, Math.floor(safeNumber(arg('trace-every', 5), 5)));
  const outRoot = path.resolve(arg('out', path.join('.sim_runs', `mbri-${utcName()}`)));
  fs.mkdirSync(outRoot, { recursive: true });

  const api = loadCore(root);
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'vehicle_profiles', 'mbri.json'), 'utf8'));
  const runs = [];
  const startedAt = new Date().toISOString();
  const previousTraceFlag = process.env.MBRI_TRACE;
  process.env.MBRI_TRACE = '1';

  for (const seed of seeds){
    const started = Date.now();
    process.stdout.write(`[MBri] seed=${seed} ${runs.length + 1}/${seeds.length}\n`);
    const mbriTrace = [];
    const mbriTraceErrors = [];
    try {
      const result = await runBattle({
        api,
        seed,
        scene: 'center',
        vehicles: { us: profile },
        us: 'python robot_adapter.py robots/mbri_adapter.py',
        them: 'fsm',
        dt: 0.05,
        maxSteps,
        actionTimeout: 300,
        includeTrace: true,
        traceEvery,
        realtime: false,
        externalVision: true,
        autoMount: true,
        autoMountRoles: ['us'],
        autoMountPose: { us: { x: 1.9, y: 1.9, th: 0 } },
        onLog: message => { if (process.env.MBRI_BATCH_VERBOSE) process.stdout.write(`${message}\n`); },
        onPolicyStderr: (role, line) => parseMbriTraceLine(role, line, mbriTrace, mbriTraceErrors),
      });
      const runRecord = {
        seed,
        ok: true,
        scores: result.scores,
        perception: result.perception || null,
        simT: result.simT,
        steps: result.steps,
        done: result.done,
        doneReason: result.doneReason,
        metrics: result.metrics,
        autoMount: result.autoMount,
        policyStats: result.policyStats,
        warnings: result.warnings,
        diagnostics: result.diagnostics,
        robots: result.robots,
        logTail: result.logTail,
        events: result.events || [],
        trace: result.trace || [],
        traceMeta: result.traceMeta || null,
        mbriTrace,
        mbriTraceErrors,
        mbriTraceSummary: summarizeMbriTrace(mbriTrace),
        elapsedMs: Date.now() - started,
      };
      runRecord.fallContexts = fallContexts(runRecord, mbriTrace);
      runs.push(runRecord);
    } catch (error) {
      const runRecord = {
        seed,
        ok: false,
        error: String(error && error.message || error),
        mbriTrace,
        mbriTraceErrors,
        mbriTraceSummary: summarizeMbriTrace(mbriTrace),
        elapsedMs: Date.now() - started,
      };
      runRecord.fallContexts = fallContexts(runRecord, mbriTrace);
      runs.push(runRecord);
    }
  }
  if (previousTraceFlag === undefined) delete process.env.MBRI_TRACE;
  else process.env.MBRI_TRACE = previousTraceFlag;

  const successful = runs.filter(run => run.ok);
  const scores = successful.map(run => ({
    us: Number(run.scores && run.scores.us || 0),
    them: Number(run.scores && run.scores.them || 0),
  }));
  const summary = {
    total: runs.length,
    success: successful.length,
    failed: runs.length - successful.length,
    meanUsScore: scores.length ? scores.reduce((sum, score) => sum + score.us, 0) / scores.length : null,
    meanThemScore: scores.length ? scores.reduce((sum, score) => sum + score.them, 0) / scores.length : null,
    meanNetScore: scores.length ? scores.reduce((sum, score) => sum + score.us - score.them, 0) / scores.length : null,
    usWinRate: scores.length ? scores.filter(score => score.us > score.them).length / scores.length : null,
    mountRate: successful.length ? successful.filter(run => run.metrics && run.metrics.us && run.metrics.us.mounted).length / successful.length : null,
    autoMounts: successful.reduce((sum, run) => sum + Number(run.autoMount && run.autoMount.counts && run.autoMount.counts.us || 0), 0),
    usFalls: successful.reduce((sum, run) => sum + (run.fallContexts || []).filter(item => item.role === 'us').length, 0),
    themFalls: successful.reduce((sum, run) => sum + (run.fallContexts || []).filter(item => item.role === 'them').length, 0),
    visionGoodFrames: successful.reduce((sum, run) => sum + (run.mbriTrace || []).filter(item => item.good === true).length, 0),
    visionBadFrames: successful.reduce((sum, run) => sum + (run.mbriTrace || []).filter(item => item.bad === true).length, 0),
    timeoutCount: successful.reduce((sum, run) => sum + Number(run.policyStats && run.policyStats.us && run.policyStats.us.timeoutCount || 0), 0),
    protocolFaults: successful.reduce((sum, run) => sum + Number(run.policyStats && run.policyStats.us && run.policyStats.us.protocolFault || 0), 0),
  };
  const output = {
    format: 'mbri-batch-v1',
    startedAt,
    finishedAt: new Date().toISOString(),
    settings: {
      seeds,
      maxSteps,
      dt: 0.05,
      realtime: false,
      externalVision: true,
      scene: 'center',
      autoMount: true,
      autoMountRoles: ['us'],
      traceEvery,
      strategy: 'python robot_adapter.py robots/mbri_adapter.py',
      vehicleProfile: 'vehicle_profiles/mbri.json',
      mbriRoot: path.resolve(process.env.MBRI_ROOT),
    },
    summary,
    runs,
  };
  fs.writeFileSync(path.join(outRoot, 'result.json'), JSON.stringify(output, null, 2), 'utf8');
  const traceLines = [];
  for (const run of runs){
    for (const event of run.mbriTrace || []) traceLines.push(JSON.stringify({ seed: run.seed, ...event }));
  }
  fs.writeFileSync(path.join(outRoot, 'mbri-trace.jsonl'), `${traceLines.join('\n')}${traceLines.length ? '\n' : ''}`, 'utf8');
  const header = ['seed', 'ok', 'simT', 'steps', 'usScore', 'themScore', 'netScore', 'usState', 'themState', 'mounted', 'autoMounts', 'timeoutCount', 'protocolFault', 'error'];
  const rows = [header.join(',')];
  for (const run of runs){
    const us = run.robots && run.robots.us;
    const them = run.robots && run.robots.them;
    const mounted = run.metrics && run.metrics.us ? run.metrics.us.mounted : '';
    const autoMounts = run.autoMount && run.autoMounts ? run.autoMounts.us : (run.autoMount && run.autoMount.counts ? run.autoMount.counts.us : '');
    const timeoutCount = run.policyStats && run.policyStats.us ? run.policyStats.us.timeoutCount : '';
    const protocolFault = run.policyStats && run.policyStats.us ? run.policyStats.us.protocolFault : '';
    const usScore = run.scores ? run.scores.us : '';
    const themScore = run.scores ? run.scores.them : '';
    rows.push([
      run.seed, run.ok, run.simT ?? '', run.steps ?? '', usScore, themScore,
      run.scores ? Number(usScore || 0) - Number(themScore || 0) : '',
      us ? us.state : '', them ? them.state : '', mounted, autoMounts,
      timeoutCount, protocolFault, run.error || '',
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(outRoot, 'summary.csv'), `${rows.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(outRoot, 'analysis.md'), makeAnalysis(summary, runs), 'utf8');
  console.log(JSON.stringify({ out: outRoot, summary }, null, 2));
}

main().catch(error => { console.error(`MBri 批处理失败: ${error.message}`); process.exitCode = 1; });
