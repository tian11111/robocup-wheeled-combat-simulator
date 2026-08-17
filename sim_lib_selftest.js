#!/usr/bin/env node
/*
 * sim_lib_selftest.js — 子进程桥与 CORE 提取的定向回归测试。
 * 单独运行：node sim_lib_selftest.js
 */
'use strict';
const assert = require('assert');
const readline = require('readline');
const { extractCoreScript, splitCommand, spawnPolicy, loadCore, runBattle } = require('./sim_lib');

if (process.argv.includes('--fixture')) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    let obs;
    try { obs = JSON.parse(line); } catch (e) { return; }
    if (obs.mode === 'slow') {
      setTimeout(() => process.stdout.write(JSON.stringify({ v: 0.75, w: -0.25, requestId: obs.requestId }) + '\n'), 80);
      return;
    }
    // 模拟第三方库意外把看似 JSON 的调试行写到 stdout；桥必须忽略它。
    process.stdout.write('{"status":"ok"}\n');
    process.stdout.write(JSON.stringify({ v: 0.25, w: -0.5, requestId: obs.requestId }) + '\n');
  });
  return;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testSpawnPolicy(){
  const logs = [];
  const command = `"${process.execPath}" "${__filename}" --fixture`;
  const policy = spawnPolicy(command, '测试', message => logs.push(message));
  assert.ok(policy, 'fixture 子进程应能启动');
  try {
    const first = await policy.ask({ mode: 'fast' }, 200);
    assert.deepStrictEqual(first, { v: 0.25, w: -0.5 });
    assert.ok(logs.some(line => line.includes('stdout JSON 必须包含')), '杂乱 JSON 不应被当作动作');

    const timedOut = await policy.ask({ mode: 'slow' }, 15);
    assert.strictEqual(timedOut, null, '迟到动作应在超时后按安全零动作处理');
    const next = await policy.ask({ mode: 'fast' }, 200);
    assert.deepStrictEqual(next, { v: 0.25, w: -0.5 }, '下一帧必须匹配自己的 requestId，不能拿到迟到动作');
    await sleep(100);
    assert.ok(logs.some(line => line.includes('过期或未知 requestId')), '迟到动作应明确丢弃');
  } finally {
    policy.kill();
  }
}

async function testDiagnosticTrace(){
  const api = loadCore(__dirname);
  const result = await runBattle({
    api,
    seed: 42,
    us: 'fsm',
    them: 'fsm',
    maxSteps: 2,
    realtime: false,
    includeTrace: true,
    traceEvery: 1,
  });
  assert.ok(result.trace.length >= 3, '诊断轨迹应包含初始帧和每个采样步');
  assert.ok(result.trace[1].us.pose, '诊断轨迹应包含位姿');
  assert.ok(result.trace[1].us.velocity, '诊断轨迹应包含实际速度');
  assert.ok(result.trace[1].us.rawSensors, '诊断轨迹应包含原始传感器');
  assert.ok(result.trace[1].objects, '诊断轨迹应包含能量块');
  assert.ok(Array.isArray(result.trace[1].events), '诊断轨迹应包含本帧事件');
  assert.strictEqual(result.traceFormat, 'diagnostic-v1');
  assert.strictEqual(result.diagnostics.format, 'diagnostic-v1');
  assert.ok(result.diagnostics.termination);
}

async function testUnexpectedPolicyExit(){
  const api = loadCore(__dirname);
  const command = `"${process.execPath}" -e "process.exit(0)"`;
  await assert.rejects(
    runBattle({ api, seed: 43, us: command, them: 'fsm', maxSteps: 3, realtime: false, actionTimeout: 50 }),
    /runner_error\/policy_process/,
    '策略子进程意外退出不能静默按零动作继续评测',
  );
}

(async () => {
  const html = '<script src="vendor.js"></script><script type="text/javascript">\n// CORE-BEGIN\nmodule.exports = { ok:true };\n// CORE-END\n</script>';
  assert.ok(extractCoreScript(html, 'fixture.html').includes('module.exports = { ok:true }'));
  assert.deepStrictEqual(
    splitCommand('"C:\\Program Files\\Python\\python.exe" robot_adapter.py "D:\\Project Dir\\robot.py"'),
    ['C:\\Program Files\\Python\\python.exe', 'robot_adapter.py', 'D:\\Project Dir\\robot.py'],
  );
  await testSpawnPolicy();
  await testDiagnosticTrace();
  await testUnexpectedPolicyExit();
  console.log('sim_lib 自测通过 ✔');
})().catch(error => {
  console.error('sim_lib 自测失败:', error && error.stack || error);
  process.exitCode = 1;
});
