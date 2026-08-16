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

async function waitIdle(port, timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const r=await request(port,'GET','/battle/status');
    if(r.body && !r.body.running && r.body.status!=='stopping') return r.body;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('等待远程对战停止超时');
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
    r=await request(port,'GET','/vision/status');
    assert.strictEqual(r.body.roles.us.frameId,'us-1');
    assert.strictEqual(r.body.roles.us.lastLabel,'opponent');
    // 调整帧率/尺寸/画质不应清掉当前有效缓存。
    r=await request(port,'POST','/vision/config',{fps:9,width:640,quality:.4});
    assert.strictEqual(r.status,200); assert.strictEqual(r.body.roles.us.frameId,'us-1');
    r=await request(port,'POST','/vision/result',{frameId:'us-1',role:'us',width:320,height:180,detections:[]});
    assert.strictEqual(r.status,409,'重复帧必须返回 409');
    r=await request(port,'POST','/vision/result',{frameId:'us-bad',role:'us',width:320,height:180,detections:[{label:'not-a-known-class'}]});
    assert.strictEqual(r.status,400,'非法标签必须拒绝');
    r=await request(port,'GET','/vision/status');
    assert.ok(r.body.roles.us.errorCount>=2,'重复帧和非法帧应累计错误计数');
    assert.ok(r.body.roles.us.consecutiveFailures>=1,'连续失败计数应暴露给状态接口');
    r=await request(port,'POST','/vision/config',{fixedLabel:'buff'});
    assert.strictEqual(r.status,200);
    r=await request(port,'POST','/vision/result',{frameId:'us-2',role:'us',width:320,height:180,detections:[{label:'opponent',confidence:.91}]});
    assert.strictEqual(r.status,200); assert.strictEqual(r.body.status.roles.us.lastLabel,'buff','服务端应应用 fixedLabel');

    // 远程对战期间必须使用启动响应里的令牌写入视觉；无令牌请求不得串改状态。
    r=await request(port,'POST','/battle/start',{us:'fsm',them:'fsm',maxSteps:100,realtime:true});
    assert.strictEqual(r.status,200); assert.ok(r.body.controlToken);
    const token=r.body.controlToken;
    r=await request(port,'POST','/vision/config',{enabled:true});
    assert.strictEqual(r.status,403,'远程对战期间无令牌不能改视觉配置');
    r=await request(port,'POST','/vision/config',{enabled:true,controlToken:token});
    assert.strictEqual(r.status,200,'持令牌页面可以同步视觉配置');
    r=await request(port,'POST','/vision/result',{frameId:'remote-1',role:'us',detections:[],controlToken:token});
    assert.strictEqual(r.status,200,'持令牌页面可以提交视觉帧');
    await request(port,'POST','/battle/stop');
    await waitIdle(port);

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
