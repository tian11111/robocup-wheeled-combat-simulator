// build_3d.js — 从规则核心源提取 CORE, 注入 3D 模板, 生成唯一 3D 网页入口
// 用法: node build_3d.js   (在 robot-simulator/ 目录下)
// wushu_ring_sim.html 现仅作为无 DOM 核心的兼容源；用户界面统一使用 3D 页面。
const fs = require('fs');

const SRC = 'wushu_ring_sim.html';
const TPL = 'wushu_ring_sim_3d.template.html';
const OUT = 'wushu_ring_sim_3d.html';

const src = fs.readFileSync(SRC, 'utf8');
const begin = src.indexOf('CORE-BEGIN');
const end = begin < 0 ? -1 : src.indexOf('CORE-END', begin);
const scriptOpen = begin < 0 ? -1 : src.lastIndexOf('<script', begin);
const scriptBodyStart = scriptOpen < 0 ? -1 : src.indexOf('>', scriptOpen) + 1;
const scriptClose = end < 0 ? -1 : src.indexOf('</script>', end);
if (begin < 0 || end < begin || scriptOpen < 0 || scriptBodyStart <= scriptOpen || scriptClose < end) {
  console.error(`[build_3d] 错误: ${SRC} 中未找到完整 CORE-BEGIN / CORE-END 脚本块`);
  process.exit(1);
}
const core = src.slice(scriptBodyStart, scriptClose);
const tpl = fs.readFileSync(TPL, 'utf8');
if (!tpl.includes('/*__CORE__*/')) {
  console.error(`[build_3d] 错误: ${TPL} 缺少 /*__CORE__*/ 占位符`);
  process.exit(1);
}
const out = tpl.replace('/*__CORE__*/', () => core);   // 函数式替换, 避免 $ 转义问题
fs.writeFileSync(OUT, out);
console.log(`[build_3d] 已生成 ${OUT} (核心逻辑 ${core.length} 字节, 来自 ${SRC})`);
