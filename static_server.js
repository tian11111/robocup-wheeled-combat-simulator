// static_server.js — robot-simulator 静态文件服务器 (开发用)
// 用法: node static_server.js [port]   (默认 8931)
// 带 no-cache 头, 避免浏览器缓存旧版 HTML/JS
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2] || process.env.STATIC_PORT || '8931', 10);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  // 3D 是唯一用户界面；旧 2D 文件仅保留为规则核心回归源，不再作为网页入口。
  if (p === '/' || p === '/wushu_ring_sim.html') {
    res.writeHead(302, { Location:'/wushu_ring_sim_3d.html', 'Cache-Control':'no-store' });
    return res.end();
  }
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(d);
  });
}).listen(PORT, () => {
  console.log(`[static] http://localhost:${PORT}/  (robot-simulator, no-cache)`);
});
