/* physics_adapter.js — Rapier 3D 碰撞桥 + 确定性回退
 * Rapier 加载成功时创建地面、6cm 擂台台面/台阶和两台车的运动学碰撞体。
 * 核心规则仍负责“屁股正对台沿”的登台判定；这正是规则逻辑与动力学标定
 * 尚未完全等价时的安全回退。Rapier 不可用时，3D 页面继续运行回退模式。
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhysicsAdapter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const CENTER = 1.9;
  function loadScript(url, timeoutMs){
    if (typeof document === 'undefined') return Promise.resolve(false);
    if (typeof globalThis.RAPIER !== 'undefined') return Promise.resolve(true);
    return new Promise(resolve => {
      let done = false;
      const finish = ok => { if(done)return; done=true; resolve(ok); };
      const tag = document.createElement('script');
      tag.async = true; tag.src = url; tag.dataset.rapier = '1';
      tag.onload = () => finish(typeof globalThis.RAPIER !== 'undefined');
      tag.onerror = () => finish(false);
      document.head.appendChild(tag);
      setTimeout(() => finish(false), timeoutMs || 1800);
    });
  }
  function quatFromHeading(th){ return { x:0, y:Math.sin(th/2), z:0, w:Math.cos(th/2) }; }
  function create(opts){
    opts = opts || {};
    const bridge = {
      mode:'fallback', ready:false, stepHeight:0.06, world:null, bodies:Object.create(null), vehicleSigs:Object.create(null), contacts:0,
      async init(){
        const urls = opts.rapierUrls || [
          opts.rapierUrl || 'lib/rapier3d-compat.min.js',
          'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier3d-compat.min.js',
        ];
        let ok = false;
        for(const url of urls){
          ok = await loadScript(url, opts.timeoutMs || 1800);
          if(ok) break;
        }
        const R = typeof globalThis.RAPIER !== 'undefined' ? globalThis.RAPIER : null;
        if (!ok || !R) return bridge;
        try {
          if (typeof R.init === 'function') await R.init();
          bridge.world = new R.World({ x:0, y:-9.81, z:0 });
          const fixed = R.RigidBodyDesc.fixed();
          const floorBody = bridge.world.createRigidBody(fixed);
          bridge.world.createCollider(R.ColliderDesc.cuboid(2.6, 0.01, 2.6), floorBody);
          const ringBody = bridge.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0,0.03,0));
          // 顶面实体 + 四侧台阶，模拟 6cm 擂台边缘。
          bridge.world.createCollider(R.ColliderDesc.cuboid(1.2, 0.03, 1.2), ringBody);
          const edgeH = 0.03, edgeW = 0.04, span = 1.22;
          for (const [x,z,w,d] of [[0,-span,1.2,edgeW],[0,span,1.2,edgeW],[-span,0,edgeW,1.2],[span,0,edgeW,1.2]]) {
            const b = bridge.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, edgeH, z));
            bridge.world.createCollider(R.ColliderDesc.cuboid(w, edgeH, d), b);
          }
          bridge._R = R; bridge.mode = 'rapier-kinematic'; bridge.ready = true;
          return bridge;
        } catch (e) {
          bridge.mode = 'fallback'; bridge.ready = false; bridge.error = String(e && e.message || e);
          return bridge;
        }
      },
      syncRobot(role, state){
        if (!bridge.ready || !bridge.world || !bridge._R) return;
        const R = bridge._R;
        let body = bridge.bodies[role];
        const v = state.vehicle || {};
        const length = Number.isFinite(Number(v.length)) ? Number(v.length) : 0.26;
        const width = Number.isFinite(Number(v.width)) ? Number(v.width) : 0.26;
        const height = Number.isFinite(Number(v.height)) ? Number(v.height) : 0.09;
        const sig = [length,width,height].map(x=>x.toFixed(4)).join('/');
        if (body && bridge.vehicleSigs[role] !== sig){
          try { bridge.world.removeRigidBody(body); } catch (e) { /* 兼容旧 Rapier */ }
          delete bridge.bodies[role];
          delete bridge.vehicleSigs[role];
          body = null;
        }
        if (!body) {
          body = bridge.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
          bridge.world.createCollider(R.ColliderDesc.cuboid(length/2,height/2,width/2).setFriction(0.8), body);
          bridge.vehicleSigs[role] = sig;
          bridge.bodies[role] = body;
        }
        body.setNextKinematicTranslation({
          x:state.x-CENTER,
          y:(state.onPlatform ? 0.06+height/2 : height/2),
          z:CENTER-state.y,
        });
        body.setNextKinematicRotation(quatFromHeading(-state.th));
      },
      syncBlock(role, state){ void role; void state; },
      step(dt){
        if (!bridge.ready || !bridge.world) return;
        bridge.world.timestep = Math.max(0.001, Math.min(0.1, Number(dt) || 0.05));
        bridge.world.step();
        bridge.contacts = 0;
        if (bridge.world.contactPair) bridge.contacts = 1;
      },
      status(){ return { mode:bridge.mode, ready:bridge.ready, stepHeight:bridge.stepHeight, contacts:bridge.contacts, error:bridge.error || '' }; },
    };
    return bridge;
  }
  return { create, loadScript };
});
