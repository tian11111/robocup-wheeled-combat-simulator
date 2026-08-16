#!/usr/bin/env node
/*
 * sim_vision_http_selftest.js — 可选 YOLO 缓存与 HTTP 接口回归测试。
 * 只使用 Node 标准库；不需要安装或启动真实 YOLO 模型。
 */
'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { loadCore } = require('./sim_lib');

function request(port, method, path, body){
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname:'127.0.0.1', port, path, method,
      headers: payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {} }, res => {
      let text='';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json=null; try { json=text ? JSON.parse(text) : null; } catch (_) {} resolve({status:res.statusCode, body:json, text}); });
    });
    req.on('error', reject);
    if(payload) req.write(payload);
    req.end();
  });
}

async function freePort(){
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitHealth(port, child){
  const deadline = Date.now()+5000;
  let last;
  while(Date.now()<deadline){
    if(child.exitCode!==null) throw new Error(`sim_server 提前退出(${child.exitCode})`);
    try { const r=await request(port,'GET','/health'); if(r.status===200) return r.body; } catch(e){ last=e; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw last || new Error('等待 sim_server 健康检查超时');
}

async function testCore(){
  const core=loadCore(__dirname);
  core.resetAll({seed:42});
  core.params.classifyRate=100;
  core.setExternalVisionCache({enabled:true,maxAgeMs:50,clear:true});
  const target={obj:{kind:'buff'},d:0.2,rel:'f'};
  const fallback=core.classifyTargetFor(core.US,target);
  assert.strictEqual(fallback.label,'buff','外部视觉没有结果时应回退 classifyRate');
  assert.strictEqual(fallback.source,'classifyRate');
  assert.ok(core.updateExternalVisionResult('us',{frameId:'us-1',width:640,height:360,detections:[{label:'enemy',confidence:.9,bbox:[300,150,40,40]}]},Date.now()));
  const yolo=core.classifyTargetFor(core.US,target);
  assert.strictEqual(yolo.label,'opponent','enemy 别名应归一化为 opponent');
  assert.strictEqual(yolo.source,'yolo');
  assert.strictEqual(core.updateExternalVisionResult('us',{frameId:'us-1',detections:[]},Date.now()),false,'重复帧必须丢弃');
  core.updateExternalVisionResult('us',{frameId:'us-2',width:640,height:360,detections:[{label:'opponent',confidence:1}]},Date.now()-1000);
  const stale=core.classifyTargetFor(core.US,target);
  assert.strictEqual(stale.source,'classifyRate','过期缓存必须回退 classifyRate');
  core.setExternalVisionCache({enabled:false,clear:true});
  assert.strictEqual(core.getSimVisionInfo().mode,'default');
}

async function testServer(){
  const port=await freePort();
  const child=spawn(process.execPath,['sim_server.js',String(port)],{cwd:__dirname,stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stderr.on('data',b=>{stderr+=String(b);});
  try{
    await waitHealth(port,child);
    let r=await request(port,'GET','/vision/status');
    assert.strictEqual(r.status,200); assert.strictEqual(r.body.enabled,false);
    r=await request(port,'POST','/vision/config',{enabled:true,maxAgeMs:120,fps:7,width:320,quality:.5,fixedLabel:'opponent'});
    assert.strictEqual(r.status,200); assert.strictEqual(r.body.settings.width,320); assert.strictEqual(r.body.settings.fixedLabel,'opponent');
    r=await request(port,'POST','/vision/result',{frameId:'us-1',role:'us',width:320,height:180,detections:[{label:'enemy',confidence:.91,bbox:[140,70,40,40]}]});
    assert.strictEqual(r.status,200); assert.strictEqual(r.body.role,'us');
    r=await request(port,'POST','/vision/result',{frameId:'us-1',role:'us',width:320,height:180,detections:[]});
    assert.strictEqual(r.status,409,'重复帧必须返回 409');
    r=await request(port,'POST','/reset',{seed:42});
    assert.strictEqual(r.status,200);
    r=await request(port,'GET','/vision/status');
    assert.strictEqual(r.body.enabled,true,'reset 不应关闭视觉开关');
    assert.strictEqual(r.body.roles.us.frameId,null,'reset 应清空视觉缓存');
  } finally {
    child.kill();
    await new Promise(resolve=>child.once('exit',resolve));
    if(stderr && child.exitCode!==0) throw new Error(stderr);
  }
}

(async()=>{
  await testCore();
  await testServer();
  console.log('sim_vision_http_selftest 通过 ✔');
})().catch(error=>{ console.error('sim_vision_http_selftest 失败:',error&&error.stack||error); process.exitCode=1; });
