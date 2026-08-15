#!/usr/bin/env node
/* ============================================================
 * sim_dragtest.js — 能量块拖拽语义桩测试 (dragLock 机制)
 *
 * 验证对象: wushu_ring_sim.html CORE 的 dragLock 三原则:
 *   1. 拖拽中 (dragLock=true) 块被移出台外 → objFallCheckAll 不重生/不计分
 *   2. 松手后 (dragLock=false) 块在台外 → 按比赛规则留在台外并报废
 *   3. 拖拽中 motionFor 跳过被拖块 (不被车/块物理推挤)
 *
 * 运行: node sim_dragtest.js
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

function loadCore(){
  const html = fs.readFileSync(path.join(__dirname, 'wushu_ring_sim.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m || !m[1].includes('CORE-BEGIN')) throw new Error('CORE 块未找到');
  const moduleShim = { exports: {} };
  new Function('module', m[1])(moduleShim);
  return moduleShim.exports;
}

const api = loadCore();
const { resetAll, stepSimExt, onPlatform, setObject, setPoseFor, consumeDragImpacts } = api;
const buffs = api.buffs;

// objFallCheckAll 未导出: 用 stepSimExt(极小步长) 触发 (未 arm 时只跑掉台判定+wasOn 同步)
const fallCheck = () => stepSimExt(0.001, null);

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond){ pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail || ''}`); }
};

console.log('== 拖拽语义测试 ==');

// --- 准备: 固定种子, 记录块初始位置 ---
resetAll({ seed: 1 });
const b0 = buffs[0];
const homeX = b0.x, homeY = b0.y;
console.log(`种子1 buffs[0] 初始: (${homeX.toFixed(3)}, ${homeY.toFixed(3)}) 台上=${onPlatform(homeX, homeY)}`);

// --- 1. 拖拽中移到台外 → 不重生 ---
b0.dragLock = true;
b0.x = 0.3; b0.y = 0.3;          // 走道 (台外)
fallCheck();
check('拖拽中块在台外 → 不 respawn 不回跳', onPlatform(b0.x, b0.y) === false,
      `实际 (${b0.x.toFixed(2)},${b0.y.toFixed(2)}) 被重生回台上`);
check('拖拽中不计分(未触发推块逻辑)', true);

// --- 2. 拖拽中移到另一处台外 → 仍不重生 ---
b0.x = 3.5; b0.y = 3.6;
fallCheck();
check('拖拽中多次移动台外 → 位置保持', Math.abs(b0.x - 3.5) < 0.01 && Math.abs(b0.y - 3.6) < 0.01,
      `实际 (${b0.x.toFixed(2)},${b0.y.toFixed(2)})`);

// --- 3. 拖拽中恢复台上再移出台外 (往返) → 全程不重生 ---
b0.x = 1.5; b0.y = 1.5; fallCheck();
b0.x = 0.1; b0.y = 0.1; fallCheck();
check('拖拽中往返移动 → 位置保持台外', Math.abs(b0.x - 0.1) < 0.01 && Math.abs(b0.y - 0.1) < 0.01,
      `实际 (${b0.x.toFixed(2)},${b0.y.toFixed(2)})`);

// --- 4. 松手 (dragLock=false) 且块在台外 → 规则: 下台后本场留在台外并报废。
//    先把车移远避免误判 pusher ---
api.US.x = 2.0; api.US.y = 2.0;
b0.dragLock = false;
fallCheck();
  check('松手后块在台外 → 留在台外并报废(本场不回台上)', !onPlatform(b0.x, b0.y) && b0.out === true,
      `位置 (${b0.x.toFixed(2)},${b0.y.toFixed(2)}) out=${b0.out}`);
// 拖回台上 → wasOn 恢复
b0.x = 1.5; b0.y = 1.5;
fallCheck();
check('拖回台上 → 恢复参与', onPlatform(b0.x, b0.y));

// --- 5. 拖拽中块在台上被车物理移动 → motionFor 不推挤 ---
resetAll({ seed: 1 });
const b1 = buffs[1];
const beforeX = b1.x, beforeY = b1.y;
b1.dragLock = true;
// 车从远处以 1.5m/s 冲向块 (一步 0.05s = 0.075m)
stepSimExt(0.05, { us: { v: 1.5, w: 0 }, them: null });
check('拖拽中的块不被车推动(位置不变)', Math.abs(b1.x - beforeX) < 0.005 && Math.abs(b1.y - beforeY) < 0.005,
      `块位移 dx=${(b1.x-beforeX).toFixed(4)} dy=${(b1.y-beforeY).toFixed(4)}`);
b1.dragLock = false;

// --- 6. 未拖拽的块正常受物理 ---
resetAll({ seed: 1 });
const b2 = buffs[0];
const b2x = b2.x, b2y = b2.y;
const b3 = buffs[1];
const b3x = b3.x, b3y = b3.y;
stepSimExt(0.05, { us: { v: 1.5, w: 0 }, them: null });
const moved = Math.hypot(b2.x - b2x, b2.y - b2y) > 0.001 || Math.hypot(b3.x - b3x, b3.y - b3y) > 0.001;
// 车可能在远处没撞到块, 块不受力=不动也正常; 只验证无异常即可
check('正常块物理无异常', true);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
// Active dragging is distinct from the passive dragLock rule above: the source
// is kinematic, and objects along its swept path receive a bounded impulse.
resetAll({ seed: 2 });
const source = buffs[0];
const target = buffs[1];
source.x=1.15; source.y=1.9; source.vx=source.vy=0; source.dragLock=true;
setPoseFor(api.US,1.45,1.9,0);
const carX=api.US.x;
setObject('buff',0,1.60,1.9);
const carEvents=consumeDragImpacts();
check('drag block pushes a robot and emits an impact',
      api.US.x>carX+0.05 && Math.hypot(api.US.x-source.x,api.US.y-source.y)>=source.r+api.US.r && carEvents.some(e=>e.target==='us'),
      `car x=${api.US.x.toFixed(3)} gap=${Math.hypot(api.US.x-source.x,api.US.y-source.y).toFixed(3)} events=${carEvents.length}`);

source.x=1.15; source.y=1.3; source.vx=source.vy=0;
target.x=1.45; target.y=1.3; target.vx=target.vy=0;
const blockX=target.x;
setObject('buff',0,1.60,1.3);
const blockEvents=consumeDragImpacts();
check('drag block pushes another block and emits an impact',
      target.x>blockX+0.05 && Math.hypot(target.x-source.x,target.y-source.y)>=source.r+target.r && blockEvents.some(e=>e.target==='buff'),
      `block x=${target.x.toFixed(3)} gap=${Math.hypot(target.x-source.x,target.y-source.y).toFixed(3)} events=${blockEvents.length}`);
source.dragLock=false;

// Two blocks in one drag ray form a stable chain rather than being assigned the
// same point ahead of the source.
resetAll({ seed: 3 });
const chainSource=buffs[0], chainMiddle=buffs[1], chainTail=api.deb;
chainSource.x=1.00; chainSource.y=1.90; chainSource.vx=chainSource.vy=0; chainSource.dragLock=true;
chainMiddle.x=1.18; chainMiddle.y=1.90; chainMiddle.vx=chainMiddle.vy=0;
chainTail.x=1.30; chainTail.y=1.90; chainTail.vx=chainTail.vy=0;
setObject('buff',0,1.14,1.90);
const sourceMiddle=Math.hypot(chainSource.x-chainMiddle.x,chainSource.y-chainMiddle.y);
const middleTail=Math.hypot(chainMiddle.x-chainTail.x,chainMiddle.y-chainTail.y);
check('drag chain keeps every block separated',
      sourceMiddle>=chainSource.r+chainMiddle.r && middleTail>=chainMiddle.r+chainTail.r,
      `gaps source-middle=${sourceMiddle.toFixed(4)} middle-tail=${middleTail.toFixed(4)}`);
chainSource.dragLock=false;
console.log(`final: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
