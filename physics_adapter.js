/* physics_adapter.js — Rapier 3D 碰撞桥 + 确定性回退
 *
 * 这里是“仅决策逻辑仿真”的辅助物理层：比赛核心仍是位置、登台和计分的
 * 唯一来源，Rapier 只负责在 3D 页面中提供可观测的碰撞/接触状态。这样
 * 即使浏览器无法下载 WASM，或某个 Rapier 版本的 API 略有差异，页面也会
 * 安全地退回到 CORE 中的确定性台阶判定，不会改变无头 API 的结果。
 *
 * 兼容入口（旧页面继续可用）：
 *   const p = PhysicsAdapter.create(opts);
 *   await p.init();
 *   p.syncRobot(role, state); p.syncBlock(id, state); p.step(dt);
 *   p.status(); p.getState();
 */
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhysicsAdapter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';

  const CENTER = 1.9;
  const DEFAULT_STEP_HEIGHT = 0.06;
  const DEFAULT_PLATFORM_HALF = 1.2;
  const DEFAULT_FRICTION = 0.85;
  const DEFAULT_RESTITUTION = 0.08;
  const DEFAULT_TIMEOUT = 2500;
  const scriptCache = new Map();
  const initCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  function finite(value, fallback){
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function positive(value, fallback, min){
    return Math.max(min || 0, finite(value, fallback));
  }
  function clamp(value, lo, hi){ return Math.max(lo, Math.min(hi, value)); }
  function hasDocument(){ return typeof document !== 'undefined' && !!document.createElement; }

  function timeoutPromise(promise, timeoutMs, fallback){
    const ms = Math.max(50, finite(timeoutMs, DEFAULT_TIMEOUT));
    return new Promise(resolve => {
      let done = false;
      let timer = null;
      const finish = value => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(fallback), ms);
      Promise.resolve(promise).then(finish, () => finish(fallback));
    });
  }

  function globalRapier(){
    return typeof globalThis !== 'undefined' && globalThis.RAPIER ? globalThis.RAPIER : null;
  }

  /** Load one browser script once. Kept as a public helper for old integrations. */
  function loadScript(url, timeoutMs){
    if (globalRapier()) return Promise.resolve(true);
    if (!hasDocument() || !url) return Promise.resolve(false);
    const key = String(url);
    if (scriptCache.has(key)) return scriptCache.get(key);
    const p = new Promise(resolve => {
      let done = false;
      const finish = ok => {
        if (done) return;
        done = true;
        resolve(!!ok);
      };
      const tag = document.createElement('script');
      tag.async = true;
      tag.src = key;
      tag.dataset.rapier = '1';
      tag.onload = () => finish(!!globalRapier());
      tag.onerror = () => finish(false);
      try { (document.head || document.documentElement).appendChild(tag); }
      catch (e) { finish(false); }
      setTimeout(() => finish(!!globalRapier()), Math.max(50, finite(timeoutMs, DEFAULT_TIMEOUT)));
    });
    scriptCache.set(key, p);
    return p;
  }

  function normalizeUrls(opts){
    const configured = opts && opts.rapierUrls;
    const urls = Array.isArray(configured) ? configured.slice() : (configured ? [configured] : []);
    if (opts && opts.rapierUrl) urls.unshift(opts.rapierUrl);
    // The local path is intentionally first: teams can vendor the exact WASM build
    // for offline use. CDN entries are only a browser convenience fallback.
    if (!urls.length) urls.push(
      'lib/rapier3d-compat.min.js',
      './lib/rapier3d-compat.min.js',
      'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier3d-compat.min.js',
      'https://unpkg.com/@dimforge/rapier3d-compat@0.14.0/rapier3d-compat.min.js'
    );
    return [...new Set(urls.filter(Boolean).map(String))];
  }

  function normalizeModuleUrls(opts){
    const configured = opts && (opts.rapierModuleUrls || opts.rapierModuleUrl);
    const urls = Array.isArray(configured) ? configured.slice() : (configured ? [configured] : []);
    // @dimforge/rapier3d-compat 0.14 ships an ESM build with the WASM payload
    // inlined as base64. Importing it is more reliable than injecting a script
    // tag (and works when the page is opened from a local static server).
    if (!urls.length) urls.push(
      './lib/rapier.es.js',
      'lib/rapier.es.js',
      'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js'
    );
    return [...new Set(urls.filter(Boolean).map(String))];
  }

  function pickModuleRapier(mod){
    if (!mod) return null;
    return mod.RAPIER || mod.default || mod;
  }

  // Rapier compat's init() changed its accepted options between releases. Pass
  // locateFile only when explicitly configured; the default resolver remains in
  // charge for CDN builds and old releases.
  function initRapier(R, opts){
    if (!R || typeof R.init !== 'function') return Promise.resolve(R);
    if (initCache && initCache.has(R)) return initCache.get(R);
    const initOpts = {};
    const wasmUrl = opts && (opts.wasmUrl || opts.rapierWasmUrl);
    if (wasmUrl) initOpts.locateFile = () => String(wasmUrl);
    const p = timeoutPromise(Promise.resolve().then(() => R.init(Object.keys(initOpts).length ? initOpts : undefined)).then(() => R),
      opts && opts.timeoutMs, null).then(value => {
        // A timed-out/failed init must not poison future retries with a different
        // wasmUrl or timeout setting.
        if (!value && initCache) initCache.delete(R);
        return value;
      });
    if (initCache) initCache.set(R, p);
    return p;
  }

  async function loadRapier(opts){
    const existing = globalRapier();
    if (existing) return initRapier(existing, opts);

    // Node users may install @dimforge/rapier3d-compat. Requiring it is optional
    // and deliberately never turns a missing dependency into a hard failure.
    if (!hasDocument() && typeof require === 'function') {
      try {
        const mod = require('@dimforge/rapier3d-compat');
        const R = pickModuleRapier(mod);
        if (R) return initRapier(R, opts);
      } catch (e) { /* browser/static fallback below */ }
    }

    // Browser-first ESM path. The package's rapier.es.js contains the compiled
    // WASM payload, so no second .wasm request is needed for offline hosting.
    if (hasDocument()) {
      for (const url of normalizeModuleUrls(opts || {})) {
        try {
          const mod = await import(/* webpackIgnore: true */ url);
          const R = pickModuleRapier(mod);
          const initialized = await initRapier(R, { ...(opts || {}), sourceUrl:url });
          if (initialized) return initialized;
        } catch (e) { /* try the next local/CDN module */ }
      }
    }

    for (const url of normalizeUrls(opts || {})) {
      const loaded = await loadScript(url, opts && opts.timeoutMs);
      const R = globalRapier();
      if (loaded && R) {
        const initialized = await initRapier(R, { ...(opts || {}), sourceUrl:url });
        if (initialized) return initialized;
      }
    }
    return null;
  }

  function quatFromHeading(th){
    const a = finite(th, 0) / 2;
    return { x:0, y:Math.sin(a), z:0, w:Math.cos(a) };
  }
  function worldPosition(state, height, stepHeight){
    const on = !!(state && state.onPlatform);
    // 台阶 3D 姿态: CORE 提供连续 zG(重心高度)时优先使用, 消除 0/0.06 二值瞬切。
    const base = (state && state.zG !== undefined && state.zG !== null) ? finite(state.zG, 0) : (on ? stepHeight : 0);
    return {
      x:finite(state && state.x, CENTER) - CENTER,
      y:base + height / 2,
      z:CENTER - finite(state && state.y, CENTER),
    };
  }
  function safeHandle(collider){
    return collider && collider.handle !== undefined ? String(collider.handle) : '';
  }

  function create(opts){
    opts = opts || {};
    const bridge = {
      // Public legacy fields.
      mode:'fallback',
      ready:false,
      stepHeight:positive(opts.stepHeight, DEFAULT_STEP_HEIGHT, 0.001),
      world:null,
      bodies:Object.create(null),
      vehicleSigs:Object.create(null),
      contacts:0,

      // New state/diagnostics fields. None of these are required by CORE.
      blocks:Object.create(null),
      loading:false,
      loadingState:'idle',
      backend:'fallback',
      error:'',
      stepCount:0,
      lastDt:0,
      lastEvents:[],
      contactPairs:[],
      geometry:null,
      capabilities:{},
      _R:null,
      _eventQueue:null,
      _initPromise:null,
      _activeContacts:new Set(),
      _colliderMeta:new Map(),
      _bodyMeta:Object.create(null),
      _blockMeta:Object.create(null),
      _eventSeq:0,

      async init(){
        if (bridge.ready) return bridge;
        if (bridge._initPromise) return bridge._initPromise;
        bridge.loading = true;
        bridge.loadingState = 'loading';
        bridge.error = '';
        bridge._initPromise = (async () => {
          try {
            const R = await loadRapier(opts);
            if (!R || typeof R.World !== 'function' || !R.RigidBodyDesc || !R.ColliderDesc) {
              throw new Error('Rapier 3D WASM 不可用');
            }
            bridge._R = R;
            bridge._createWorld();
            bridge.mode = 'rapier-kinematic';
            bridge.backend = 'rapier3d-compat-wasm';
            bridge.ready = true;
            bridge.loading = false;
            bridge.loadingState = 'ready';
            bridge.error = '';
            return bridge;
          } catch (e) {
            bridge.ready = false;
            bridge.loading = false;
            bridge.loadingState = 'fallback';
            bridge.mode = 'fallback';
            bridge.backend = 'fallback';
            bridge.error = String(e && e.message || e || 'Rapier 初始化失败');
            return bridge;
          } finally {
            bridge._initPromise = null;
          }
        })();
        return bridge._initPromise;
      },

      _applyColliderOptions(desc, options){
        const o = options || {};
        const friction = clamp(positive(o.friction, DEFAULT_FRICTION, 0), 0, 2);
        const restitution = clamp(positive(o.restitution, DEFAULT_RESTITUTION, 0), 0, 1);
        try { if (desc && typeof desc.setFriction === 'function') desc.setFriction(friction); } catch (e) { /* old API */ }
        try { if (desc && typeof desc.setRestitution === 'function') desc.setRestitution(restitution); } catch (e) { /* old API */ }
        try {
          const R = bridge._R;
          const flags = R && R.ActiveEvents && R.ActiveEvents.COLLISION_EVENTS;
          if (flags !== undefined && desc && typeof desc.setActiveEvents === 'function') desc.setActiveEvents(flags);
        } catch (e) { /* collision events are optional */ }
        return desc;
      },

      _registerCollider(collider, meta){
        if (!collider) return collider;
        const handle = safeHandle(collider) || `${meta && meta.kind || 'collider'}:${++bridge._eventSeq}`;
        bridge._colliderMeta.set(handle, { ...(meta || {}), handle });
        // userData is useful to callers inspecting Rapier directly, but not every
        // compat build exposes setUserData; assigning the JS property is harmless.
        try { if (typeof collider.setUserData === 'function') collider.setUserData({ ...(meta || {}), handle }); } catch (e) { /* old API */ }
        try { collider.userData = { ...(meta || {}), handle }; } catch (e) { /* frozen wrapper */ }
        return collider;
      },

      _createFixed(kind, halfExtents, position, material){
        const R = bridge._R;
        const descBody = R.RigidBodyDesc.fixed();
        // RigidBodyDesc.setTranslation uses scalar arguments in Rapier JS;
        // body.setTranslation later accepts a vector object. Keep both forms
        // separate so old compat builds do not silently create a body at 0,0,0.
        if (typeof descBody.setTranslation === 'function') {
          descBody.setTranslation(position.x, position.y, position.z);
        }
        const body = bridge.world.createRigidBody(descBody);
        const desc = bridge._applyColliderOptions(R.ColliderDesc.cuboid(
          halfExtents.x, halfExtents.y, halfExtents.z
        ), material);
        const collider = bridge.world.createCollider(desc, body);
        bridge._registerCollider(collider, { kind, role:kind, bodyType:'fixed' });
        return { body, collider };
      },

      _createWorld(){
        const R = bridge._R;
        bridge.world = new R.World({ x:0, y:-9.81, z:0 });
        bridge._eventQueue = typeof R.EventQueue === 'function' ? new R.EventQueue(true) : null;
        const platformHalf = positive(opts.platformHalf, DEFAULT_PLATFORM_HALF, 0.1);
        const floorHalf = positive(opts.floorHalf, 2.6, platformHalf + 0.1);
        const floorThickness = positive(opts.floorThickness, 0.02, 0.001);
        const step = bridge.stepHeight;
        bridge.geometry = {
          platformSize:platformHalf * 2,
          platformTop:step,
          platformHalf,
          stepHeight:step,
          floorSize:floorHalf * 2,
          riserThickness:positive(opts.riserThickness, 0.04, 0.005),
        };

        // Ground top is y=0; the platform top is exactly y=0.06 by default.
        bridge._createFixed('floor',
          { x:floorHalf, y:floorThickness / 2, z:floorHalf },
          { x:0, y:-floorThickness / 2, z:0 },
          { friction:positive(opts.floorFriction, 0.7, 0), restitution:0.02 });
        bridge._createFixed('platform',
          { x:platformHalf, y:step / 2, z:platformHalf },
          { x:0, y:step / 2, z:0 },
          { friction:positive(opts.platformFriction, 0.95, 0), restitution:0.04 });

        // Explicit risers make the 6cm vertical face inspectable and avoid the
        // “floating top slab” ambiguity when a vehicle straddles the edge.
        const t = bridge.geometry.riserThickness;
        const riserY = step / 2;
        bridge._createFixed('riser-south',
          { x:platformHalf, y:step / 2, z:t / 2 },
          { x:0, y:riserY, z:-platformHalf - t / 2 },
          { friction:0.9, restitution:0.02 });
        bridge._createFixed('riser-north',
          { x:platformHalf, y:step / 2, z:t / 2 },
          { x:0, y:riserY, z:platformHalf + t / 2 },
          { friction:0.9, restitution:0.02 });
        bridge._createFixed('riser-west',
          { x:t / 2, y:step / 2, z:platformHalf },
          { x:-platformHalf - t / 2, y:riserY, z:0 },
          { friction:0.9, restitution:0.02 });
        bridge._createFixed('riser-east',
          { x:t / 2, y:step / 2, z:platformHalf },
          { x:platformHalf + t / 2, y:riserY, z:0 },
          { friction:0.9, restitution:0.02 });

        bridge.capabilities = {
          wasm:true,
          collisionEvents:!!bridge._eventQueue,
          ccd:false,
          kinematicBodies:true,
          dynamicImpulse:false,
          stepGeometry:true,
        };
      },

      _removeBody(body, collider){
        if (collider) {
          const handle = safeHandle(collider);
          bridge._colliderMeta.delete(handle);
          if (handle) {
            for (const key of [...bridge._activeContacts]) {
              if (key === handle || key.startsWith(`${handle}:`) || key.endsWith(`:${handle}`)) {
                bridge._activeContacts.delete(key);
              }
            }
          }
        }
        bridge.contacts = bridge._activeContacts.size;
        if (body && bridge.world) {
          try { bridge.world.removeRigidBody(body); } catch (e) { /* compat versions differ */ }
        }
      },

      _vehicleSignature(v){
        const fields = ['length','width','height','frontExtent','rearExtent','sideExtent',
          'mass','friction','restitution','linearDamping','angularDamping'];
        return fields.map(k => finite(v && v[k], 0).toFixed(5)).join('/');
      },

      _makeRobotBody(role, state){
        const R = bridge._R;
        const v = state && state.vehicle || {};
        const length = positive(v.length, 0.26, 0.02);
        const width = positive(v.width, 0.26, 0.02);
        const height = positive(v.height, 0.09, 0.01);
        const front = Math.max(length / 2, positive(v.frontExtent, length / 2, 0.01));
        const rear = Math.max(length / 2, positive(v.rearExtent, length / 2, 0.01));
        const side = Math.max(width / 2, positive(v.sideExtent, width / 2, 0.01));
        const body = bridge.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
        try {
          if (typeof body.enableCcd === 'function' && opts.ccd !== false) {
            body.enableCcd(true);
            bridge.capabilities.ccd = true;
          }
        } catch (e) { /* optional in older Rapier builds */ }
        try { if (typeof body.setLinearDamping === 'function') body.setLinearDamping(positive(v.linearDamping, 3, 0)); } catch (e) { /* kinematic */ }
        try { if (typeof body.setAngularDamping === 'function') body.setAngularDamping(positive(v.angularDamping, 4, 0)); } catch (e) { /* kinematic */ }
        try { if (typeof body.setAdditionalMass === 'function') body.setAdditionalMass(positive(v.mass, 1, 0.01), true); } catch (e) { /* old API */ }
        const desc = bridge._applyColliderOptions(R.ColliderDesc.cuboid(
          (front + rear) / 2, height / 2, side
        ), {
          friction:positive(v.friction, 0.85, 0),
          restitution:positive(v.restitution, 0.08, 0),
        });
        // Offset the hull so the local +X side includes the configured shovel.
        try {
          if (typeof desc.setTranslation === 'function') desc.setTranslation((front - rear) / 2, 0, 0);
        } catch (e) { /* old API */ }
        const collider = bridge.world.createCollider(desc, body);
        bridge._registerCollider(collider, { kind:'robot', role, bodyType:'kinematic' });
        bridge._bodyMeta[role] = { body, collider, kind:'robot', role };
        bridge.bodies[role] = body;
        bridge.vehicleSigs[role] = bridge._vehicleSignature(v);
        return body;
      },

      syncRobot(role, state){
        if (!bridge.ready || !bridge.world || !bridge._R || !state) return;
        const key = role === 'them' ? 'them' : 'us';
        const v = state.vehicle || {};
        const sig = bridge._vehicleSignature(v);
        let body = bridge.bodies[key];
        if (body && bridge.vehicleSigs[key] !== sig) {
          const old = bridge._bodyMeta[key];
          bridge._removeBody(body, old && old.collider);
          delete bridge.bodies[key];
          delete bridge.vehicleSigs[key];
          delete bridge._bodyMeta[key];
          body = null;
        }
        if (!body) body = bridge._makeRobotBody(key, state);
        const h = positive(v.height, 0.09, 0.01);
        const p = worldPosition(state, h, bridge.stepHeight);
        try {
          if (typeof body.setNextKinematicTranslation === 'function') body.setNextKinematicTranslation(p);
          else if (typeof body.setTranslation === 'function') body.setTranslation(p, true);
          if (typeof body.setNextKinematicRotation === 'function') body.setNextKinematicRotation(quatFromHeading(-finite(state.th, 0)));
          else if (typeof body.setRotation === 'function') body.setRotation(quatFromHeading(-finite(state.th, 0)), true);
          if (typeof body.setLinvel === 'function') body.setLinvel({ x:finite(state.vx, finite(state.v, 0)), y:0, z:-finite(state.vy, 0) }, true);
        } catch (e) {
          bridge.error = `Rapier syncRobot: ${String(e && e.message || e)}`;
        }
      },

      syncBlock(role, state){
        if (!bridge.ready || !bridge.world || !bridge._R || !state) return;
        const key = String(role || 'block');
        const size = positive(state.size, 0.15, 0.01);
        const width = positive(state.width, size, 0.01);
        const depth = positive(state.depth, size, 0.01);
        const height = positive(state.height, size, 0.01);
        const sig = [width,depth,height,finite(state.mass,0.3)].map(n => n.toFixed(5)).join('/');
        let body = bridge.blocks[key];
        const old = bridge._blockMeta[key];
        if (body && old && old.sig !== sig) {
          bridge._removeBody(body, old.collider);
          delete bridge.blocks[key];
          delete bridge._blockMeta[key];
          body = null;
        }
        if (!body) {
          const R = bridge._R;
          body = bridge.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
          try {
            if (typeof body.enableCcd === 'function' && opts.ccd !== false) {
              body.enableCcd(true);
              bridge.capabilities.ccd = true;
            }
          } catch (e) { /* optional in older Rapier builds */ }
          const desc = bridge._applyColliderOptions(R.ColliderDesc.cuboid(width/2,height/2,depth/2), {
            friction:positive(state.friction, 0.72, 0), restitution:positive(state.restitution, 0.12, 0),
          });
          const collider = bridge.world.createCollider(desc, body);
          bridge._registerCollider(collider, { kind:'block', role:key, blockKind:state.kind || '' , bodyType:'kinematic' });
          bridge.blocks[key] = body;
          bridge._blockMeta[key] = { body, collider, sig, kind:'block', role:key };
        }
        const bx = finite(state.x, CENTER), by = finite(state.y, CENTER);
        const platformHalf = bridge.geometry ? bridge.geometry.platformHalf : DEFAULT_PLATFORM_HALF;
        const inferredOn = Math.abs(bx - CENTER) <= platformHalf && Math.abs(by - CENTER) <= platformHalf;
        const on = state.onPlatform === undefined ? inferredOn : !!state.onPlatform;
        const p = {
          x:bx - CENTER,
          // CORE's out flag means "scoring already resolved". Keep the body
          // on the real floor so a visible fallen block remains collidable.
          y:(on ? bridge.stepHeight : 0) + height/2,
          z:CENTER - by,
        };
        try {
          if (typeof body.setEnabled === 'function') body.setEnabled(true);
          if (typeof body.setNextKinematicTranslation === 'function') body.setNextKinematicTranslation(p);
          else if (typeof body.setTranslation === 'function') body.setTranslation(p, true);
        } catch (e) { bridge.error = `Rapier syncBlock: ${String(e && e.message || e)}`; }
      },

      syncState(state){
        if (!state) return;
        const robots = state.robots || {};
        if (robots.us) bridge.syncRobot('us', robots.us);
        if (robots.them) bridge.syncRobot('them', robots.them);
        const objects = state.objects || {};
        (objects.buffs || []).forEach((b, i) => bridge.syncBlock(`buff:${i}`, b));
        if (objects.debuff) bridge.syncBlock('debuff', objects.debuff);
      },

      _consumeEvents(){
        bridge.lastEvents = [];
        if (!bridge._eventQueue || typeof bridge._eventQueue.drainCollisionEvents !== 'function') {
          bridge.contacts = bridge._activeContacts.size;
          return;
        }
        try {
          bridge._eventQueue.drainCollisionEvents((h1, h2, started) => {
            const a = String(h1), b = String(h2);
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            if (started) bridge._activeContacts.add(key);
            else bridge._activeContacts.delete(key);
            const ma = bridge._colliderMeta.get(a) || { kind:'unknown', handle:a };
            const mb = bridge._colliderMeta.get(b) || { kind:'unknown', handle:b };
            bridge.lastEvents.push({
              key, started:!!started, a:{...ma}, b:{...mb},
              step:bridge.stepCount,
            });
          });
        } catch (e) {
          bridge.error = `Rapier contact events: ${String(e && e.message || e)}`;
        }
        if (bridge.lastEvents.length > 64) bridge.lastEvents = bridge.lastEvents.slice(-64);
        bridge.contacts = bridge._activeContacts.size;
        bridge.contactPairs = [...bridge._activeContacts].slice(0, 64).map(key => {
          const sep = key.indexOf(':');
          const a = key.slice(0, sep), b = key.slice(sep + 1);
          return { key, a:bridge._colliderMeta.get(a) || { handle:a }, b:bridge._colliderMeta.get(b) || { handle:b } };
        });
      },

      step(dt){
        if (!bridge.ready || !bridge.world) return bridge.status();
        const d = clamp(finite(dt, 0.05), 0.001, 0.1);
        bridge.lastDt = d;
        bridge.stepCount += 1;
        try {
          // Rapier exposes timestep as a writable property in compat builds;
          // older builds simply use their current timestep, which is harmless.
          try { bridge.world.timestep = d; } catch (e) { /* old API */ }
          if (bridge._eventQueue) bridge.world.step(bridge._eventQueue);
          else bridge.world.step();
          bridge._consumeEvents();
        } catch (e) {
          // Do not throw into GameEngine's animation loop. The next status call
          // advertises fallback while CORE keeps running deterministically.
          bridge.error = String(e && e.message || e || 'Rapier step failed');
          bridge.mode = 'fallback';
          bridge.backend = 'fallback';
          bridge.ready = false;
          bridge.loadingState = 'fallback';
        }
        return bridge.status();
      },

      getState(){
        const out = {
          mode:bridge.mode,
          ready:bridge.ready,
          stepCount:bridge.stepCount,
          contacts:bridge.contacts,
          contactPairs:bridge.contactPairs.slice(),
          lastEvents:bridge.lastEvents.slice(),
          bodies:Object.create(null),
          blocks:Object.create(null),
        };
        const readBody = body => {
          if (!body) return null;
          let p = {}, q = {}, v = {};
          try { p = typeof body.translation === 'function' ? body.translation() : {}; } catch (e) { /* noop */ }
          try { q = typeof body.rotation === 'function' ? body.rotation() : {}; } catch (e) { /* noop */ }
          try { v = typeof body.linvel === 'function' ? body.linvel() : {}; } catch (e) { /* noop */ }
          return {
            position:{ x:+finite(p.x,0).toFixed(5), y:+finite(p.y,0).toFixed(5), z:+finite(p.z,0).toFixed(5) },
            rotation:{ x:+finite(q.x,0).toFixed(5), y:+finite(q.y,0).toFixed(5), z:+finite(q.z,0).toFixed(5), w:+finite(q.w,1).toFixed(5) },
            velocity:{ x:+finite(v.x,0).toFixed(5), y:+finite(v.y,0).toFixed(5), z:+finite(v.z,0).toFixed(5) },
          };
        };
        for (const role of Object.keys(bridge.bodies)) out.bodies[role] = readBody(bridge.bodies[role]);
        for (const role of Object.keys(bridge.blocks)) out.blocks[role] = readBody(bridge.blocks[role]);
        return out;
      },

      state(){ return bridge.getState(); },

      status(){
        return {
          mode:bridge.mode,
          backend:bridge.backend,
          ready:bridge.ready,
          loading:bridge.loading,
          loadingState:bridge.loadingState,
          stepHeight:bridge.stepHeight,
          contacts:bridge.contacts,
          contactPairs:bridge.contactPairs.length,
          bodies:Object.keys(bridge.bodies).length,
          blocks:Object.keys(bridge.blocks).length,
          colliders:bridge._colliderMeta.size,
          stepCount:bridge.stepCount,
          geometry:bridge.geometry ? { ...bridge.geometry } : null,
          capabilities:{ ...bridge.capabilities },
          error:bridge.error || '',
        };
      },
    };
    return bridge;
  }

  return { create, loadScript, loadRapier };
});
