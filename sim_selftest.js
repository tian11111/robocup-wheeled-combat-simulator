// 确定性状态机全路径测试（双车核心）：直接驱动 stepSim / stepSimExt
// 用法: node sim_selftest.js   （需同目录 wushu_ring_sim.html）
const fs2 = require('fs');
const html = fs2.readFileSync('wushu_ring_sim.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];   // 第一个 script = CORE 块
if (!script.includes('CORE-BEGIN')) { console.error('未找到 CORE 块!'); process.exit(2); }

global.document={getElementById:()=>({addEventListener:()=>{}}),addEventListener:()=>{}};
global.window={addEventListener:()=>{}};
global.navigator={};

eval(script + "\n;global.__T = global.__T || { fs, fs2, bot, opp, US, THEM, robots, blocks, buffs, deb, params, arm, resetAll, startManual, stepSim, stepSimExt, getState, getLog, setPose, setPoseFor, setObject, scenePreset, setVehicleFor, getVehicleFor, setFieldGrayMap, getFieldGrayMap, getFieldGrayInfo, setSimVision, getSimVisionInfo, classifyTargetFor, onPlatform, onStage, hangOn, fullOn, fieldGray, distToNearestEdge, toDoneFor, enterSearchFor, beginPreparation, pauseMatch, resumeMatch, restartFor, consumeDragImpacts };");
const T = global.__T;
let failures = 0;
const assert = (cond, msg)=>{ if(cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ FAIL: ${msg}`); } };
const wait = ms => { const n = Math.ceil(ms/16.7); for(let i=0;i<n;i++) T.stepSim(0.0167); };
const resetScene = seed => T.resetAll({ seed });

console.log('== 场景 1: 发令 → 双车登台 → SEARCH 系 ==');
resetScene(42); T.arm(); wait(6000);
assert(T.onStage(T.US), `6s 后我方应在台上, 实际 (${T.US.x.toFixed(2)},${T.US.y.toFixed(2)})`);
assert(T.onStage(T.THEM), `6s 后对手应在台上, 实际 (${T.THEM.x.toFixed(2)},${T.THEM.y.toFixed(2)})`);
for(const r of T.robots){
  assert(['SEARCH','SCORE_BLOCK','ATTACK','RECOVER'].includes(r.fsm.state), `${r.name} 6s 后应已登台进入搜索, 实际 ${r.fsm.state}`);
}

console.log('== 场景 2: 危机门控 (悬空+运动) → RECOVER backup ==');
resetScene(7); T.arm(); wait(6000);
T.setPoseFor(T.US, 0.84, 1.9, Math.PI);               // 车头朝西悬空
T.US.fsm.state='ATTACK';                              // 强制运动状态
let sawRecover=false;
for(let i=0;i<60;i++){ T.stepSim(0.0167); if(T.US.fsm.state==='RECOVER'){ sawRecover=true; break; } }
assert(sawRecover, `危机门控应进 RECOVER, 实际 ${T.US.fsm.state}`);
wait(4000);
assert(!T.hangOn(T.US), '恢复后不应悬空');

console.log('== 场景 3: 掉台 → RECOVER spin → 姿态登台 ==');
resetScene(1); T.arm(); wait(6000);
T.fs.wasOn = true;
T.setPoseFor(T.US, 0.5, 1.9, 0);
wait(300);
assert(T.US.fsm.state==='RECOVER', `掉台应进 RECOVER, 实际 ${T.US.fsm.state}`);
assert(T.US.fsm.rec.phase==='spin', `应为 spin(屁股朝擂台), 实际 ${T.US.fsm.rec.phase}`);
wait(9000);
assert(['SEARCH','SCORE_BLOCK','ATTACK','RECOVER'].includes(T.US.fsm.state), `姿态登台后应回 SEARCH 系, 实际 ${T.US.fsm.state}`);

console.log('== 场景 4: 前冲找墙 → 触发丢失 → 正向登台 ==');
resetScene(3); T.arm();
T.setPoseFor(T.US, 1.9, 0.35, -Math.PI/2);
T.US.fsm.mount.phase='rush'; T.US.fsm.mount.t=0; T.US.fsm.mount.rushSeen=false;
wait(9000);
assert(['SEARCH','SCORE_BLOCK','ATTACK'].includes(T.US.fsm.state), `前冲登台后应 SEARCH 系, 实际 ${T.US.fsm.state}`);
assert(T.onStage(T.US), '前冲后我方应在台上');

console.log('== 场景 5: 恢复次数超限 → FINISHED ==');
resetScene(5); T.arm(); wait(6000);
T.US.fsm.rec.count = T.params.RECOVER_LIMIT;
T.fs.wasOn = true;
T.setPoseFor(T.US, 0.5, 1.9, 0);
wait(300);
assert(T.US.fsm.state==='FINISHED', `超限应 FINISHED, 实际 ${T.US.fsm.state}`);

console.log('== 场景 6: 比赛时间到 → FINISHED ==');
resetScene(6); T.arm(); T.US.fsm.timer = 0.3; T.THEM.fsm.timer = 0.3;
wait(2000);
assert(T.US.fsm.state==='FINISHED' && T.THEM.fsm.state==='FINISHED', `时间到应双车 FINISHED, 实际 ${T.US.fsm.state}/${T.THEM.fsm.state}`);

console.log('== 场景 7: ATTACK 推对手(静止)掉台 → 我方+1 ==');
resetScene(8); T.arm();
T.setPoseFor(T.THEM, 2.78, 1.9, Math.PI);             // 对手近东缘
T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START'; // 停用对手 FSM(静止靶)
T.setPoseFor(T.US, 2.3, 1.9, 0);                      // 我方朝东
for(const b of T.buffs){ b.x=0.3; b.y=0.3; b.wasOn=false; }
T.deb.x=0.3; T.deb.y=0.5; T.deb.wasOn=false;
wait(12000);
console.log(`  (场景7: 我方=${T.US.fsm.state}, 比分=${T.getState().scores.us}:${T.getState().scores.them}, 对手=(${T.THEM.x.toFixed(2)},${T.THEM.y.toFixed(2)}))`);
assert(T.getState().scores.us>=1 && !T.onStage(T.THEM),
  `应把对手推下擂台得分, 实际比分 ${T.getState().scores.us} 对手在台=${T.onStage(T.THEM)}`);

console.log('== 场景 8: 场景预设可用 ==');
resetScene(9);
for(const [name, expect] of [['center',[1.9,1.9]],['edge',[0.7,1.9]],['walkway',[1.9,0.35]],['hang',[0.84,1.9]]]){
  T.scenePreset(name);
  assert(Math.abs(T.US.x-expect[0])<0.01 && Math.abs(T.US.y-expect[1])<0.01, `${name} → (${T.US.x.toFixed(2)},${T.US.y.toFixed(2)})`);
}
T.scenePreset('opp_on');  assert(T.onStage(T.THEM), 'opp_on → 对手上台');
T.scenePreset('opp_start'); assert(T.THEM.x>3.0&&T.THEM.y>3.0, 'opp_start → 对手回出发区');

console.log('== 场景 9: 灰度模型 ==');
const gRed=T.fieldGray(1.9,1.9), gWhite=T.fieldGray(2.2,2.2), gEdge=T.fieldGray(0.7,1.9), gFloor=T.fieldGray(0.3,0.3);
assert(gRed>600&&gRed<700, `中央红区≈650, 实际 ${gRed.toFixed(0)}`);
assert(gWhite>800, `白区≈825, 实际 ${gWhite.toFixed(0)}`);
assert(gEdge>=290&&gEdge<=310, `边缘黑带≈300, 实际 ${gEdge.toFixed(0)}`);
assert(gFloor===0, `走道=0, 实际 ${gFloor}`);

console.log('== 场景 10: 确定性(同种子结果一致) ==');
resetScene(123); T.arm(); wait(30000);
const s1 = T.getState();
resetScene(123); T.arm(); wait(30000);
const s2 = T.getState();
const same = s1.scores.us===s2.scores.us && s1.scores.them===s2.scores.them
  && Math.abs(s1.robots.us.x-s2.robots.us.x)<1e-6 && Math.abs(s1.robots.them.x-s2.robots.them.x)<1e-6;
assert(same, `同种子两集一致: 比分 ${s1.scores.us}:${s1.scores.them} vs ${s2.scores.us}:${s2.scores.them}`);

console.log('== 场景 11: 外部策略(stepSimExt)分别控制两车 ==');
resetScene(4); T.arm();
T.setPoseFor(T.US, 0.5, 1.9, 0);                      // 走道朝东
let usMoved=false, themActed=false;
for(let i=0;i<600;i++){
  T.stepSimExt(0.0167, { us:{v:0.9,w:0}, them:null });
  if(T.US.x>2.0) usMoved=true;
  if(T.THEM.fsm.state!=='WAIT_START' && T.THEM.fsm.state!=='MANUAL') themActed=true;
}
assert(usMoved, '我方被外部策略驱动移动');
assert(themActed, '对手仍由自身 FSM 决策');
assert(T.US.fsm.action.includes('外部策略'), `我方动作标签, 实际 ${T.US.fsm.action}`);

console.log('== 场景 12: 双车混战 60s 无异常 ==');
resetScene(11); T.arm();
let err=null, sawUs=false, sawThem=false;
try {
  for(let k=0;k<60;k++){
    wait(1000);
    for(const e of T.getLog()){
      if(e.msg.includes('我方')) sawUs=true;
      if(e.msg.includes('对手')) sawThem=true;
    }
  }
} catch(e){ err=e; }
assert(!err, err ? '混战异常: '+err.message : '双车混战 60s 无异常');
assert(sawUs && sawThem, `日志包含双方事件 (我方=${sawUs}, 对手=${sawThem})`);
console.log(`  比分 ${T.getState().scores.us}:${T.getState().scores.them} | 我方${T.US.fsm.state} 对手${T.THEM.fsm.state} | 时间 ${T.US.fsm.simT.toFixed(0)}s`);

// ---------- 场景 13: 能量块下台即报废 (2026-08-14 规则) ----------
// 规则: 块被推下台后本场不再参与(静止在台外), 比赛结束 resetAll 才重新摆放
console.log('== 场景 13: 能量块推下台即报废(比赛结束才 resetAll 恢复) ==');
{
  resetScene(5);
  const b = T.buffs[0];
  assert(T.onPlatform(b.x, b.y), `初始块在台上, 实际 (${b.x.toFixed(2)},${b.y.toFixed(2)})`);
  // 车放到块旁(作为 pusher, 块移走后车在 0.6m 内) → 触发掉台计分+报废
  T.setPoseFor(T.US, 0.5, 0.3, 0);
  T.fs.wasOn = true;
  b.wasOn = true; b.x = 0.3; b.y = 0.3;
  T.stepSim(0.05);
  assert(b.out === true, `车推下的块应报废(out=true), 实际 out=${b.out}`);
  assert(!T.onPlatform(b.x, b.y), '块留在台外');
  const preScores = T.getState().scores;
  // 推 3 秒: 块不应回台上(本场不再参与)
  let cameBack = false;
  for (let i = 0; i < 60; i++){ T.stepSim(0.05); if (T.onPlatform(b.x, b.y)){ cameBack = true; break; } }
  assert(!cameBack, '推下后本场不回台上');
  // resetAll → 恢复回台上
  T.resetAll({ seed: 5 });
  assert(T.onPlatform(b.x, b.y) && b.out === false, `resetAll 恢复回台上, 实际 (${b.x.toFixed(2)},${b.y.toFixed(2)}) out=${b.out}`);
}

console.log('== 场景 14: SEARCH 扫描避边(压黑带朝外 → 倒车回台) ==');
resetScene(21); T.arm(); wait(6000);
T.setPoseFor(T.US, 0.90, 1.9, Math.PI);               // 台上靠西边, 车头朝西(台外)
T.US.fsm.scan = { dir: 1, phase:'scan', target:null, t:0, side:1 };
let sawEvade=false;
for(let i=0;i<300;i++){
  T.stepSim(0.0167);
  if(T.US.fsm.action.includes('扫描避边')) sawEvade=true;
  if(sawEvade && !T.hangOn(T.US) && i>40) break;
}
assert(sawEvade, `应出现扫描避边动作, 实际 ${T.US.fsm.action}`);
assert(!T.hangOn(T.US), '避边后前端应回台');
assert(T.US.fsm.state==='SEARCH', `应仍在 SEARCH, 实际 ${T.US.fsm.state}`);

console.log('== 场景 15: 连续 5 分钟仿真无异常(压力) ==');
resetScene(11); T.arm();
err=null; const t0=Date.now();
try { for(let i=0;i<18000;i++) T.stepSim(0.0167); } catch(e){ err=e; }
console.log(`  18000 帧(5分钟)耗时 ${Date.now()-t0}ms`);
assert(!err, err ? '压力测试异常: '+err.message : '18000 帧(5分钟)无异常');
console.log(`  最终比分 ${T.getState().scores.us}:${T.getState().scores.them}, 状态 ${T.US.fsm.state}/${T.THEM.fsm.state}`);

// ---------- 场景 16: 台壁阻挡物理 (2026-08-12, 2026-08-14 收紧) ----------
// 真机 6cm 台阶语义: **必须屁股正对边缘垂直登台**(2026-08-14 规则)——垂直+速度足够可登台 /
// 斜撞(含斜 45° 骑台角)滑行不穿台 / 慢速不穿透 / 台上→台下自由掉落
console.log('== 场景 16: 台壁阻挡物理 (垂直登台/斜撞滑行/慢速不穿/掉落) ==');
{
  // 垂直冲台 (0.585=内置 FSM 倒车登台速度) → 应登台
  resetScene(1); T.US.x=1.9; T.US.y=0.3; T.US.th=Math.PI/2; T.US.v=0; T.US.w=0;
  let ok1=false;
  for(let i=0;i<40;i++){ T.stepSimExt(0.05,{us:{v:0.585,w:0},them:null}); if(T.onPlatform(T.US.x,T.US.y)){ ok1=true; break; } }
  assert(ok1, '垂直冲台 0.585m/s 登台');
  // 斜 30° 冲台 → 被挡不穿台
  resetScene(1); T.US.x=1.9; T.US.y=0.3; T.US.th=Math.PI/2-0.5; T.US.v=0; T.US.w=0;
  let ok2=false;
  for(let i=0;i<60;i++){ T.stepSimExt(0.05,{us:{v:0.585,w:0},them:null}); if(T.onPlatform(T.US.x,T.US.y)){ ok2=true; } }
  assert(!ok2, '斜 30° 撞台沿被挡(不穿台)');
  // 斜 45° 骑台角 → 2026-08-14 规则: 不再允许(必须屁股正对边缘), 应被挡
  resetScene(1); T.US.x=0.45; T.US.y=0.45; T.US.th=Math.PI/4+Math.PI; T.US.v=0; T.US.w=0;
  let ok3=false;
  for(let i=0;i<60;i++){ T.stepSimExt(0.05,{us:{v:-0.585,w:0},them:null}); if(T.onPlatform(T.US.x,T.US.y)){ ok3=true; } }
  assert(!ok3, '斜 45° 骑台角被挡(2026-08-14 规则: 必须垂直登台)');
  // 慢速顶住 → 不穿透
  resetScene(1); T.US.x=1.9; T.US.y=0.3; T.US.th=Math.PI/2; T.US.v=0; T.US.w=0;
  let ok4=false;
  for(let i=0;i<60;i++){ T.stepSimExt(0.05,{us:{v:0.2,w:0},them:null}); if(T.onPlatform(T.US.x,T.US.y)){ ok4=true; } }
  assert(!ok4, '慢速 0.2m/s 顶台沿不穿透');
  // 台上→台下自由掉落
  resetScene(1); T.US.x=1.9; T.US.y=1.9; T.US.th=Math.PI; T.US.v=0; T.US.w=0;
  let ok5=false;
  for(let i=0;i<70;i++){ T.stepSimExt(0.05,{us:{v:0.6,w:0},them:null}); if(!T.onPlatform(T.US.x,T.US.y)){ ok5=true; break; } }
  assert(ok5, '台上→台下自由掉落(不阻挡)');
}

console.log('== 场景 17: 掉台计分边界(同时掉台/另一方已在台下) ==');
{
  resetScene(31); T.arm();
  T.US.fsm.state='SEARCH'; T.THEM.fsm.state='SEARCH';
  T.US.wasOn=true; T.THEM.wasOn=true;
  T.setPoseFor(T.US,0.5,1.9,0); T.setPoseFor(T.THEM,3.3,1.9,Math.PI);
  T.stepSim(0.05);
  assert(T.getState().scores.us===0 && T.getState().scores.them===0,
    '双方同帧掉台不得分');

  resetScene(32); T.arm();
  T.US.fsm.state='SEARCH'; T.THEM.fsm.state='WAIT_START'; T.THEM.fsm.armed=false;
  T.US.wasOn=true; T.THEM.wasOn=false;
  T.setPoseFor(T.US,0.5,1.9,0); T.setPoseFor(T.THEM,3.3,1.9,Math.PI);
  T.stepSim(0.05);
  assert(T.getState().scores.us===0 && T.getState().scores.them===0,
    '另一方已在台下时掉台不得分');
}

console.log('== 场景 18: 消极比赛超过10秒 → 对方+1 ==');
{
  resetScene(33);
  T.setPoseFor(T.US,1.9,1.9,0); T.setPoseFor(T.THEM,3.5,3.5,0);
  T.arm(); T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  for(let i=0;i<700;i++) T.stepSimExt(0.0167,{us:{v:0,w:0},them:null});
  assert(T.US.fsm.inactiveWarned && T.getState().scores.them>=1,
    `我方静止超过10秒应触发消极判罚, 比分 ${T.getState().scores.us}:${T.getState().scores.them}`);
}

console.log('== 场景 19: 能量块最后接触者计分 ==');
{
  resetScene(34);
  const b=T.buffs[0];
  T.setPoseFor(T.US,b.x-0.3,b.y,0); T.US.fsm.armed=true; T.US.fsm.state='MANUAL'; T.US.wasOn=true;
  T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  for(let i=0;i<100 && !b.out;i++) T.stepSimExt(0.05,{us:{v:1,w:0},them:null});
  assert(b.out && b.lastContactRole==='us' && T.getState().scores.us>=3,
    `最后接触者应获得增益块+3, 实际 ${b.lastContactRole}/${T.getState().scores.us}:${T.getState().scores.them}`);
}

console.log('== 场景 20: 赛前准备 60s → READY → 发令 RUNNING ==');
{
  resetScene(35);
  assert(T.getState().match.phase==='PREP' && T.getState().match.prepRemaining===60,
    '重置后应进入 PREP, 准备时间 60s');
  for(let i=0;i<1200;i++) T.stepSim(0.05);
  assert(T.getState().match.phase==='READY' && T.getState().match.prepRemaining===0,
    `准备倒计时结束应 READY, 实际 ${T.getState().match.phase}`);
  T.arm();
  assert(T.getState().match.phase==='RUNNING', `发令后应 RUNNING, 实际 ${T.getState().match.phase}`);
}

console.log('== 场景 21: 暂停/继续冻结与恢复比赛时钟 ==');
{
  resetScene(36); T.arm(); T.stepSim(0.05);
  const before=T.getState().match.timer;
  T.pauseMatch('selftest'); T.stepSim(1.0);
  assert(T.getState().match.phase==='PAUSED' && T.getState().match.timer===before,
    '暂停时阶段和比赛计时应冻结');
  T.resumeMatch(); T.stepSim(0.05);
  assert(T.getState().match.phase==='RUNNING' && T.getState().match.timer<before,
    '继续后应恢复 RUNNING 且计时继续');
}

console.log('== 场景 22: 调试+3 / 重启+4 判罚归对方 ==');
{
  resetScene(37); T.arm();
  T.restartFor('us','debug'); T.restartFor('them','restart');
  const st=T.getState();
  assert(st.scores.us===4 && st.scores.them===3 && st.match.restartPenalties.us===3 && st.match.restartPenalties.them===4,
    `判罚比分/累计应为 4:3, 实际 ${st.scores.us}:${st.scores.them}`);
}

console.log('== 场景 23: 自定义小车参数与 footprint 防穿模 ==');
{
  resetScene(38);
  const before=T.getVehicleFor('us');
  T.setVehicleFor('us', { id:'test-car', length:0.40, width:0.30, frontExtent:0.25,
    rearExtent:0.20, sideExtent:0.16, collisionRadius:0.22, maxSpeed:0.4 });
  const v=T.getVehicleFor('us');
  assert(v.id==='test-car' && v.length===0.4 && v.maxSpeed===0.4,
    `自定义参数应保存, 实际 ${v.id}/${v.length}/${v.maxSpeed}`);
  T.setPoseFor(T.US,1.9,0.55,Math.PI/2); T.US.fsm.armed=true; T.US.fsm.state='MANUAL';
  T.stepSimExt(0.5,{us:{v:0.2,w:0},them:null});
  assert(T.US.y + v.frontExtent <= 0.701,
    `低速接近台沿不得穿过 footprint, 实际 y=${T.US.y.toFixed(3)} 前端=${(T.US.y+v.frontExtent).toFixed(3)}`);
  T.stepSimExt(0.05,{us:{v:1.5,w:0},them:null});
  assert(Math.abs(T.US.v)<=0.401, `最高速度应按车辆参数限幅, 实际 ${T.US.v.toFixed(3)}`);
  T.setVehicleFor('us', { maxSpeed:2.4 });
  T.setPoseFor(T.US,1.9,1.9,0);
  T.stepSimExt(0.05,{us:{v:2.0,w:0},them:null});
  assert(T.US.v>1.5 && T.US.v<=2.401, `自定义最高速度应可被外部策略使用, 实际 ${T.US.v.toFixed(3)}`);
  T.setVehicleFor('us', before);
}

console.log('== 场景 24: resetAll / 双车车辆 profile 独立传入 ==');
{
  resetScene(39);
  const beforeUs=T.getVehicleFor('us');
  const beforeThem=T.getVehicleFor('them');
  T.resetAll({ seed:39, vehicles:{
    us:{id:'yellow-32', length:0.32, width:0.24, maxSpeed:1.1},
    them:{id:'blue-18', length:0.18, width:0.20, mass:0.7},
  }});
  const st=T.getState();
  assert(st.robots.us.vehicle.id==='yellow-32' && st.robots.us.vehicle.length===0.32 &&
         st.robots.them.vehicle.id==='blue-18' && st.robots.them.vehicle.mass===0.7,
    `resetAll 应分别应用 us/them profile, 实际 ${st.robots.us.vehicle.id}/${st.robots.them.vehicle.id}`);
  T.resetAll({ seed:39, vehicles:{us:beforeUs, them:beforeThem}});
}

console.log('== 场景 25: 高速线段扫掠避免穿过能量块 ==');
{
  resetScene(40);
  const b=T.buffs[0];
  const before=T.getVehicleFor('us');
  T.setVehicleFor('us', { length:0.08, width:0.08, frontExtent:0.04, rearExtent:0.04,
    sideExtent:0.04, collisionRadius:0.04, maxSpeed:3.0, accelK:40, pushFactor:1.0 });
  T.setPoseFor(T.US,b.x-0.15,b.y,0); T.US.fsm.armed=true; T.US.fsm.state='MANUAL';
  T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  const oldX=b.x;
  T.stepSimExt(0.1,{us:{v:3.0,w:0},them:null});
  assert(b.lastContactRole==='us' && b.x>oldX,
    `高速跨帧仍应扫掠命中并推动能量块, 实际 role=${b.lastContactRole} x=${b.x.toFixed(3)}`);
  T.setVehicleFor('us', before);
}

console.log('== 场景 26: 每车独立传感器数量/类型/布局 ==');
{
  resetScene(41);
  const before=T.getVehicleFor('us');
  const profile={
    id:'custom-11', label:'本车 11 路',
    channels:[
      {id:'gray_front',type:'gray',forward:0.11,lateral:0},
      {id:'gray_rear',type:'gray',forward:-0.11,lateral:0,angle:Math.PI},
      {id:'gray_left',type:'gray',forward:0,lateral:0.11,angle:Math.PI/2},
      {id:'gray_right',type:'gray',forward:0,lateral:-0.11,angle:-Math.PI/2},
      {id:'diag_left_front',type:'digital',angle:-Math.PI/4,range:1.6,fov:0.55},
      {id:'diag_left_rear',type:'digital',angle:3*Math.PI/4,range:1.6,fov:0.55},
      {id:'diag_right_front',type:'digital',angle:Math.PI/4,range:1.6,fov:0.55},
      {id:'diag_right_rear',type:'digital',angle:-3*Math.PI/4,range:1.6,fov:0.55},
      {id:'shovel_under_left',type:'ir_ground',forward:0.14,lateral:0.06},
      {id:'shovel_under_right',type:'ir_ground',forward:0.14,lateral:-0.06},
      {id:'shovel_front',type:'ir_edge',forward:0.16,range:0.9,fov:0.30},
    ],
    logical:{
      gF:'gray_front',gB:'gray_rear',gL:'gray_left',gR:'gray_right',
      uL:'shovel_under_left',uR:'shovel_under_right',sFL:'shovel_front',sFR:'shovel_front',
      dLF:'diag_left_front',dRF:'diag_right_front',dLB:'diag_left_rear',dRB:'diag_right_rear',
      f:{channels:['diag_left_front','diag_right_front'],reducer:'max',virtual:true},r:null,
    },
  };
  T.setVehicleFor('us',{sensors:profile});
  T.arm(); T.stepSim(0.05);
  const st=T.getState();
  assert(st.sensorLayout.us.channels.length===11, `传感器 profile 应为 11 路, 实际 ${st.sensorLayout.us.channels.length}`);
  assert(Object.keys(st.rawSensors.us).length===11, `rawSensors 应只包含 11 个真实通道, 实际 ${Object.keys(st.rawSensors.us).length}`);
  assert(st.sensorLayout.us.channels.filter(c=>c.type==='digital').length===4,
    '四路对角红外应按实车配置为 digital 类型');
  assert(st.rawSensors.us.shovel_front!==undefined && st.sensors.us.sFL===st.sensors.us.sFR,
    '单路铲前红外应保留 raw 通道并兼容映射到 sFL/sFR');
  assert(st.sensorLayout.us.channels.find(c=>c.id==='diag_left_rear').angle > 2,
    '传感器布局应保留安装朝向');
  T.setVehicleFor('us',before);
}

console.log('== 场景 27: 掉台能量块仍可碰撞，拖拽块可推开实体 ==');
{
  resetScene(42);
  const fallen=T.buffs[0];
  fallen.out=true; fallen.wasOn=false; fallen.x=0.48; fallen.y=1.9; fallen.vx=fallen.vy=0;
  T.setPoseFor(T.US,0.18,1.9,0); T.US.fsm.armed=true; T.US.fsm.state='MANUAL';
  T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  const fallenX=fallen.x;
  for(let i=0;i<16;i++) T.stepSimExt(0.05,{us:{v:1.1,w:0},them:null});
  assert(fallen.out && fallen.x>fallenX+0.01 && T.US.x<fallen.x,
    `掉台块仍应阻挡并被推动, 实际 block=${fallen.x.toFixed(3)} car=${T.US.x.toFixed(3)}`);

  const source=T.buffs[1];
  source.x=1.15; source.y=2.0; source.vx=source.vy=0; source.dragLock=true;
  T.setPoseFor(T.US,1.45,2.0,0);
  const carX=T.US.x;
  T.setObject('buff',1,1.60,2.0);
  const carEvents=T.consumeDragImpacts();
  assert(T.US.x>carX+0.05 && Math.hypot(T.US.x-source.x,T.US.y-source.y)>=source.r+T.US.r && carEvents.some(e=>e.target==='us'),
    `拖拽块应推开车辆并保持间隙, 实际 x=${T.US.x.toFixed(3)} gap=${Math.hypot(T.US.x-source.x,T.US.y-source.y).toFixed(3)}`);

  source.x=1.15; source.y=1.3; source.vx=source.vy=0;
  fallen.x=1.45; fallen.y=1.3; fallen.vx=fallen.vy=0;
  const blockX=fallen.x;
  T.setObject('buff',1,1.60,1.3);
  const blockEvents=T.consumeDragImpacts();
  assert(fallen.x>blockX+0.05 && Math.hypot(fallen.x-source.x,fallen.y-source.y)>=source.r+fallen.r && blockEvents.some(e=>e.target==='buff'),
    `拖拽块应推开另一能量块并保持间隙, 实际 x=${fallen.x.toFixed(3)} gap=${Math.hypot(fallen.x-source.x,fallen.y-source.y).toFixed(3)}`);
  source.dragLock=false;
}

console.log('== 场景 28: 双车同步对冲只解一次且不穿过 ==');
{
  resetScene(43);
  const oldRestitution=T.params.COLLISION_RESTITUTION;
  const beforeUs=T.getVehicleFor('us'), beforeThem=T.getVehicleFor('them');
  T.setVehicleFor('us',{maxSpeed:3,accelK:40,mass:1,pushFactor:1});
  T.setVehicleFor('them',{maxSpeed:3,accelK:40,mass:1,pushFactor:1});
  // 本帧两车各移动约 0.2m，若顺序处理或缺少相对扫掠会直接互相越过。
  T.setPoseFor(T.US,1.70,1.90,0); T.setPoseFor(T.THEM,2.10,1.90,Math.PI);
  T.params.COLLISION_RESTITUTION=0;
  T.stepSimExt(0.1,{us:{v:2,w:0},them:{v:2,w:0}});
  const gap=Math.hypot(T.THEM.x-T.US.x,T.THEM.y-T.US.y);
  const minGap=T.US.r+T.THEM.r;
  assert(gap>=minGap-1e-6 && T.US.x<T.THEM.x,
    `同步对冲不得互相穿过, 实际 gap=${gap.toFixed(4)} min=${minGap.toFixed(4)}`);
  assert(Math.abs(T.US.vx)<1e-6 && Math.abs(T.THEM.vx)<1e-6,
    `e=0 等质量对冲应在一次冲量后共同静止, 实际 vx=${T.US.vx.toFixed(6)}/${T.THEM.vx.toFixed(6)}`);
  // 小车半径 4cm 时，同一 100ms 步会在帧末完全越过彼此；必须回退到首次接触法线。
  resetScene(44);
  T.setVehicleFor('us',{length:0.08,width:0.08,frontExtent:0.04,rearExtent:0.04,sideExtent:0.04,
    collisionRadius:0.04,maxSpeed:3,accelK:40,mass:1,pushFactor:1});
  T.setVehicleFor('them',{length:0.08,width:0.08,frontExtent:0.04,rearExtent:0.04,sideExtent:0.04,
    collisionRadius:0.04,maxSpeed:3,accelK:40,mass:1,pushFactor:1});
  T.setPoseFor(T.US,1.50,1.90,0); T.setPoseFor(T.THEM,2.00,1.90,Math.PI);
  T.stepSimExt(0.1,{us:{v:3,w:0},them:{v:3,w:0}});
  const sweptGap=Math.hypot(T.THEM.x-T.US.x,T.THEM.y-T.US.y);
  assert(T.US.x<T.THEM.x && sweptGap>=T.US.r+T.THEM.r-1e-6,
    `高速扫掠对冲应回退至首次接触点, 实际 gap=${sweptGap.toFixed(4)} 位置=${T.US.x.toFixed(3)}/${T.THEM.x.toFixed(3)}`);
  T.params.COLLISION_RESTITUTION=oldRestitution;
  T.setVehicleFor('us',beforeUs); T.setVehicleFor('them',beforeThem);
}

console.log('== 场景 29: 实测灰度表与同步 SimVision 插件 ==');
{
  T.setFieldGrayMap({
    id:'selftest-grid',
    values:[[100,300],[500,900]],
    interpolation:'bilinear',
  });
  const grayBounds=T.getFieldGrayInfo().bounds;
  assert(T.fieldGray(grayBounds.xMin,grayBounds.yMin)===100 && T.fieldGray(grayBounds.xMax,grayBounds.yMin)===300,
    '灰度表应按南到北、西到东正确采样底边');
  assert(T.fieldGray(grayBounds.xMin,grayBounds.yMax)===500 && T.fieldGray(grayBounds.xMax,grayBounds.yMax)===900,
    '灰度表应按南到北、西到东正确采样顶边');
  assert(Math.abs(T.fieldGray(1.9,1.9)-450)<1e-9,
    `双线性插值中心应为 450, 实际 ${T.fieldGray(1.9,1.9)}`);
  assert(T.getState().perception.fieldGray.mode==='grid' && T.getFieldGrayInfo().id==='selftest-grid',
    '状态应报告当前实测灰度表元数据');
  T.setFieldGrayMap(null);
  const defaultBounds=T.getFieldGrayInfo().bounds;
  assert(T.getState().perception.fieldGray.mode==='hand_drawn' && T.fieldGray(defaultBounds.xMin,defaultBounds.yMin)===300,
    '清除灰度表后应恢复默认手绘场地');

  T.setSimVision({
    id:'selftest-vision',
    classify:()=>({label:'debuff',confidence:0.91,source:'fixture'}),
  });
  const detection=T.classifyTargetFor(T.US,{obj:T.buffs[0],d:0.2,rel:'左前'});
  assert(detection.label==='debuff' && detection.confidence===0.91 && detection.source==='fixture',
    '自定义 SimVision 应输出标准化检测结果');
  assert(T.getState().perception.vision.mode==='custom' && T.getSimVisionInfo().synchronous===true,
    '状态应报告同步自定义视觉插件');
  T.setSimVision(null);
  assert(T.getState().perception.vision.id==='classifyRate',
    '清除视觉插件后应恢复默认 classifyRate');
}

console.log('== 场景 30: 高速跨台阶扫掠与低速顶台阻挡 ==');
{
  resetScene(45);
  const beforeUs=T.getVehicleFor('us'), beforeThem=T.getVehicleFor('them');
  T.setVehicleFor('us',{maxSpeed:3,accelK:40,frontExtent:0.16,rearExtent:0.14,sideExtent:0.12});
  T.setVehicleFor('them',{maxSpeed:0.05});
  T.setPoseFor(T.US,1.9,0.50,Math.PI/2);
  T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  T.stepSimExt(0.1,{us:{v:3,w:0},them:null});
  assert(T.US.y>0.7 && T.onPlatform(T.US.x,T.US.y),
    `明确高速冲台跨帧后应进入台面, 实际 y=${T.US.y.toFixed(3)}`);

  resetScene(46);
  T.setVehicleFor('us',{maxSpeed:0.2,accelK:40,frontExtent:0.16,rearExtent:0.14,sideExtent:0.12});
  T.setVehicleFor('them',{maxSpeed:0.05});
  T.setPoseFor(T.US,1.9,0.69,Math.PI/2);
  T.THEM.fsm.armed=false; T.THEM.fsm.state='WAIT_START';
  T.stepSimExt(0.1,{us:{v:0.2,w:0},them:null});
  assert(T.US.y<0.7,
    `低速顶台应被扫掠阻挡, 实际 y=${T.US.y.toFixed(3)}`);
  T.setVehicleFor('us',beforeUs); T.setVehicleFor('them',beforeThem);
}

console.log('== 场景 31: 紧凑状态、独立传感器随机流与视觉错误诊断 ==');
{
  resetScene(47);
  const compact=T.getState({compact:true});
  assert(compact.scores && compact.robots.us && compact.sensors.us && !Object.prototype.hasOwnProperty.call(compact,'logTail'),
    '紧凑状态应保留 AI 所需位姿/传感器并省略完整日志');
  assert(compact.robots.us.vehicle.maxSpeed===T.getVehicleFor('us').maxSpeed,
    '紧凑状态应保留车辆控制上限');

  const beforeProfile=T.getVehicleFor('us');
  resetScene(48);
  const baseRaw=T.getState().rawSensors.us;
  const extended=JSON.parse(JSON.stringify(beforeProfile.sensors));
  extended.channels.push({id:'extra_gray',type:'gray',forward:0.02,lateral:0.02,angle:0,range:0.2,fov:0.2});
  T.setVehicleFor('us',{sensors:extended});
  T.resetAll({seed:48});
  const extendedRaw=T.getState().rawSensors.us;
  const stableIds=Object.keys(baseRaw).filter(id=>id!=='extra_gray');
  assert(stableIds.every(id=>Math.abs(baseRaw[id]-extendedRaw[id])<1e-9),
    '增加传感器通道不应重排既有通道的 seeded 噪声');
  T.setVehicleFor('us',beforeProfile);

  T.setSimVision({id:'throwing-vision',classify:()=>{ throw new Error('fixture vision failure'); }});
  T.classifyTargetFor(T.US,{obj:T.buffs[0],d:0.2,rel:'左前'});
  const visionState=T.getState().perception.vision;
  assert(visionState.errorCount===1 && /fixture vision failure/.test(visionState.lastError||''),
    '视觉插件异常应写入 errorCount/lastError');
  T.setSimVision(null);
}

console.log(failures===0 ? '\n全部通过 ✔' : `\n${failures} 项失败 ✘`);
process.exit(failures===0?0:1);
