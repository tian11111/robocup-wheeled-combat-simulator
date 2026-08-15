/*
 * VisualHUD - reusable Three.js HUD, camera and sensor presentation helpers.
 *
 * This module intentionally has no dependency on the simulator CORE, DOM
 * layout, or a particular robot implementation.  Load it after three.min.js:
 *
 *   <script src="visual_hud.js"></script>
 *   const hud = VisualHUD.createOverheadHUD({ scene, target: botGroup });
 *
 * All controllers expose an `object`, `update(dt, data)`, `setVisible()` and
 * `dispose()` method.  They are safe to construct in a headless Node process:
 * when THREE is unavailable the returned controller is a no-op.  The effects
 * are presentation-only and do not alter collision, scoring, or sensor data.
 */
(function installVisualHUD(root, factory) {
  var api = factory(root);
  if (root) root.VisualHUD = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function createVisualHUD(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var NOOP = function noop() {};
  var STATE_COLORS = {
    wait_start: 0x9ca8b5,
    mount_ring: 0xffb44d,
    search: 0x4da3ff,
    attack: 0xff4d5f,
    attacking: 0xff4d5f,
    score_block: 0xffd166,
    recover: 0xb07bff,
    recovery: 0xb07bff,
    finished: 0x596579,
    idle: 0x9ca8b5
  };

  function getThree(explicit) {
    return explicit || (root && root.THREE) || null;
  }

  function noopController(extra) {
    var out = {
      enabled: false,
      object: null,
      update: NOOP,
      render: NOOP,
      push: NOOP,
      add: NOOP,
      emit: NOOP,
      trigger: NOOP,
      pulse: NOOP,
      clear: NOOP,
      setVisible: NOOP,
      setMode: NOOP,
      dispose: NOOP
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
      }
    }
    return out;
  }

  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function color(THREE, value, fallback) {
    var v = value == null ? fallback : value;
    if (THREE && THREE.Color) {
      if (v && v.isColor) return v.clone ? v.clone() : v;
      try { return new THREE.Color(v); } catch (_) { return new THREE.Color(fallback); }
    }
    return v;
  }

  function vec(THREE, value, fallback) {
    if (!THREE || !THREE.Vector3) return value || fallback || { x: 0, y: 0, z: 0 };
    if (value && value.isVector3) return value.clone ? value.clone() : value;
    var src = value || fallback || { x: 0, y: 0, z: 0 };
    if (Array.isArray(src)) return new THREE.Vector3(num(src[0], 0), num(src[1], 0), num(src[2], 0));
    return new THREE.Vector3(num(src.x, 0), num(src.y, 0), num(src.z, 0));
  }

  function copyVec(THREE, out, value, fallback) {
    var v = vec(THREE, value, fallback);
    if (out && out.copy && v) out.copy(v);
    return out || v;
  }

  function resolvePosition(THREE, source, out) {
    if (!source) return null;
    if (source.isVector3) return copyVec(THREE, out, source);
    if (source.position) {
      if (typeof source.getWorldPosition === 'function') {
        try { source.getWorldPosition(out); return out; } catch (_) {}
      }
      return copyVec(THREE, out, source.position);
    }
    if (source.point) return copyVec(THREE, out, source.point);
    if (source.position && source.position.isVector3) return copyVec(THREE, out, source.position);
    if (source.x != null || source.y != null || source.z != null) return copyVec(THREE, out, source);
    if (Array.isArray(source)) return copyVec(THREE, out, source);
    return null;
  }

  function addToParent(object, options, target, attachDefault) {
    options = options || {};
    var parent = options.parent || options.scene || null;
    var attach = options.attachToTarget;
    if (attach == null) attach = attachDefault !== false && !!target && !parent;
    if (!parent && attach && target && target.add) parent = target;
    if (parent && parent.add) parent.add(object);
    return { parent: parent, attached: !!(attach && parent === target) };
  }

  function setTextureColorSpace(THREE, texture) {
    if (!texture) return;
    if (THREE && THREE.SRGBColorSpace && 'colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
    else if (THREE && THREE.sRGBEncoding != null && 'encoding' in texture) texture.encoding = THREE.sRGBEncoding;
    texture.needsUpdate = true;
  }

  function makeCanvas(width, height) {
    var doc = root && root.document;
    if (!doc || typeof doc.createElement !== 'function') return null;
    var canvas = doc.createElement('canvas');
    canvas.width = Math.max(32, Math.round(width));
    canvas.height = Math.max(32, Math.round(height));
    return canvas;
  }

  function roundedRect(ctx, x, y, w, h, radius) {
    var r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function stateColor(THREE, state, fallback) {
    var key = String(state || 'idle').toLowerCase().replace(/\s+/g, '_');
    return color(THREE, STATE_COLORS[key] == null ? fallback : STATE_COLORS[key], fallback);
  }

  function stateLabel(state) {
    var key = String(state || 'IDLE').toUpperCase();
    var labels = {
      WAIT_START: '待命', MOUNT_RING: '登台', SEARCH: '搜索', ATTACK: '攻击',
      ATTACKING: '攻击', SCORE_BLOCK: '能量块', RECOVER: '恢复', RECOVERY: '恢复',
      FINISHED: '结束', IDLE: '空闲'
    };
    return labels[key] || key.replace(/_/g, ' ');
  }

  function graySummary(data) {
    var raw = data == null ? null : data.gray;
    if (raw == null && data != null) raw = data.grayValue;
    if (raw == null && data != null) raw = data.grayscale;
    if (raw == null && data != null) raw = data.graySummary;
    if (Array.isArray(raw)) {
      var values = raw.map(Number).filter(function (v) { return Number.isFinite(v); });
      if (!values.length) return '--';
      var sum = values.reduce(function (a, b) { return a + b; }, 0);
      var avg = sum / values.length;
      return avg.toFixed(2);
    }
    if (raw && typeof raw === 'object') {
      if (raw.value != null) raw = raw.value;
      else if (raw.average != null) raw = raw.average;
      else if (raw.avg != null) raw = raw.avg;
    }
    var n = Number(raw);
    return Number.isFinite(n) ? n.toFixed(2) : '--';
  }

  /**
   * Build a billboarding overhead HUD.  `target` may be a THREE.Object3D or a
   * callback returning one.  `update` accepts `{state, v, omega/w, gray}`;
   * `v` is m/s and `omega`/`w` is rad/s.  A `gray` array is summarized by mean.
   */
  function createOverheadHUD(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Sprite || !THREE.SpriteMaterial || !THREE.CanvasTexture) {
      return noopController({ reason: 'THREE Sprite/CanvasTexture unavailable' });
    }
    var canvas = makeCanvas(num(options.width, 360), num(options.height, 96));
    if (!canvas || typeof canvas.getContext !== 'function') {
      return noopController({ reason: 'Canvas 2D unavailable' });
    }
    var ctx = canvas.getContext('2d');
    var texture = new THREE.CanvasTexture(canvas);
    setTextureColorSpace(THREE, texture);
    var material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: options.depthTest !== false,
      depthWrite: false,
      opacity: clamp(num(options.opacity, 0.96), 0, 1)
    });
    var sprite = new THREE.Sprite(material);
    var widthWorld = num(options.worldWidth, 0.56);
    var aspect = canvas.height / canvas.width;
    sprite.scale.set(widthWorld, widthWorld * aspect, 1);
    var target = options.target || null;
    var targetResolver = typeof target === 'function' ? target : function () { return target; };
    var attachInfo = addToParent(sprite, options, target, true);
    var offset = vec(THREE, options.offset, { x: 0, y: num(options.heightOffset, 0.22), z: 0 });
    var elapsed = 0;
    var visible = true;
    var values = { state: 'IDLE', v: 0, omega: 0, gray: null };

    function draw() {
      var w = canvas.width, h = canvas.height;
      var c = stateColor(THREE, values.state, 0x4da3ff);
      var css = '#' + c.getHexString();
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.shadowColor = css;
      ctx.shadowBlur = 10;
      roundedRect(ctx, 4, 4, w - 8, h - 8, 14);
      ctx.fillStyle = 'rgba(10,16,24,0.88)';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 4;
      ctx.strokeStyle = css;
      ctx.stroke();
      ctx.fillStyle = '#f4f8ff';
      ctx.font = 'bold 28px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(stateLabel(values.state), 18, 34);
      ctx.fillStyle = '#b9c7d7';
      ctx.font = '22px Consolas, monospace';
      ctx.fillText('v ' + num(values.v, 0).toFixed(2) + ' m/s', 18, 69);
      ctx.fillText('ω ' + num(values.omega, 0).toFixed(2) + ' rad/s', 178, 69);
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 20px Consolas, monospace';
      ctx.fillText('G ' + graySummary(values), 310, 69);
      ctx.restore();
      texture.needsUpdate = true;
    }

    function update(data, dt) {
      data = data || {};
      if (data.state != null || data.status != null) values.state = data.state != null ? data.state : data.status;
      if (data.v != null) values.v = num(data.v, values.v);
      else if (data.velocity && data.velocity.v != null) values.v = num(data.velocity.v, values.v);
      else if (data.velocity && data.velocity.x != null) values.v = Math.hypot(num(data.velocity.x, 0), num(data.velocity.z, 0));
      if (data.omega != null || data.w != null) values.omega = num(data.omega != null ? data.omega : data.w, values.omega);
      else if (data.velocity && data.velocity.omega != null) values.omega = num(data.velocity.omega, values.omega);
      if (data.gray != null || data.grayValue != null || data.grayscale != null || data.graySummary != null) {
        values.gray = data.gray != null ? data.gray : (data.grayValue != null ? data.grayValue : (data.grayscale != null ? data.grayscale : data.graySummary));
      }
      var t = targetResolver();
      if (t && !attachInfo.attached) {
        var p = resolvePosition(THREE, t, sprite.position);
        if (p) sprite.position.copy(p).add(offset);
      } else if (t && attachInfo.attached) {
        sprite.position.copy(offset);
      }
      elapsed += Math.max(0, num(dt, 0));
      var breathe = 0.96 + Math.sin(elapsed * TAU * 0.7) * 0.04;
      material.opacity = visible ? clamp(num(options.opacity, 0.96) * breathe, 0, 1) : 0;
      sprite.visible = visible;
      draw();
      return values;
    }

    var controller = {
      enabled: true,
      object: sprite,
      sprite: sprite,
      canvas: canvas,
      texture: texture,
      material: material,
      values: values,
      update: update,
      setData: function setData(data) { update(data, 0); return controller; },
      setState: function setState(state) { values.state = state; draw(); return controller; },
      setVisible: function setVisible(v) { visible = !!v; sprite.visible = visible; return controller; },
      setTarget: function setTarget(next) { target = next; targetResolver = typeof target === 'function' ? target : function () { return target; }; return controller; },
      dispose: function disposeHUD() {
        if (sprite.parent) sprite.parent.remove(sprite);
        if (texture.dispose) texture.dispose();
        if (material.dispose) material.dispose();
      }
    };
    draw();
    return controller;
  }

  function trailShader(THREE, options) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: color(THREE, options.color, 0x4da3ff) },
        uOpacity: { value: clamp(num(options.opacity, 0.86), 0, 1) }
      },
      vertexShader: 'attribute float aAlpha; varying float vAlpha; void main(){vAlpha=aAlpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; varying float vAlpha; void main(){float a=clamp(vAlpha*uOpacity,0.0,1.0); if(a<0.002) discard; gl_FragColor=vec4(uColor,a);}',
      transparent: true,
      depthWrite: false,
      depthTest: options.depthTest !== false,
      blending: options.additive && THREE.AdditiveBlending != null ? THREE.AdditiveBlending : THREE.NormalBlending
    });
  }

  /**
   * Keep a short, fading line behind a robot.  Pass `target` to sample its
   * world position automatically, or call `push(position)` manually.  `dt`
   * is seconds; default lifetime is 2.6s, suitable for strategy replays.
   */
  function createTrail(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.BufferGeometry || !THREE.Line || !THREE.ShaderMaterial) {
      return noopController({ reason: 'THREE line/shader classes unavailable' });
    }
    var maxPoints = clamp(Math.round(num(options.maxPoints, 180)), 8, 2048);
    var life = clamp(num(options.duration, options.maxSeconds == null ? 2.6 : options.maxSeconds), 0.1, 30);
    var positions = new Float32Array(maxPoints * 3);
    var alphas = new Float32Array(maxPoints);
    var geometry = new THREE.BufferGeometry();
    var posAttr = new THREE.BufferAttribute(positions, 3);
    var alphaAttr = new THREE.BufferAttribute(alphas, 1);
    if (posAttr.setUsage && THREE.DynamicDrawUsage != null) posAttr.setUsage(THREE.DynamicDrawUsage);
    if (alphaAttr.setUsage && THREE.DynamicDrawUsage != null) alphaAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('aAlpha', alphaAttr);
    geometry.setDrawRange(0, 0);
    var material = trailShader(THREE, options);
    var line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.userData = line.userData || {};
    line.userData.visualHUD = 'trail';
    var target = options.target || null;
    var targetResolver = typeof target === 'function' ? target : function () { return target; };
    var parent = options.parent || options.scene || null;
    if (parent && parent.add) parent.add(line);
    var records = [];
    var clock = 0;
    var sampleClock = 0;
    var sampleEvery = Math.max(0, num(options.sampleInterval, 1 / 30));
    var minDistance = Math.max(0, num(options.minDistance, 0.008));
    var yOffset = num(options.yOffset, 0.006);
    var maxJump = num(options.maxJump, 1.25);
    var visible = true;
    var last = null;
    var temp = new THREE.Vector3();

    function append(value, timestamp) {
      var p = resolvePosition(THREE, value, temp);
      if (!p) return false;
      var point = p.clone();
      point.y += yOffset;
      if (last) {
        var dx = point.x - last.x, dy = point.y - last.y, dz = point.z - last.z;
        var distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance < minDistance) return false;
        if (maxJump > 0 && distance > maxJump) records.length = 0;
      }
      records.push({ p: point, t: timestamp == null ? clock : num(timestamp, clock) });
      if (records.length > maxPoints) records.splice(0, records.length - maxPoints);
      last = point;
      return true;
    }

    function rebuild() {
      var keep = [];
      for (var i = 0; i < records.length; i++) {
        if (clock - records[i].t <= life) keep.push(records[i]);
      }
      records = keep;
      for (var j = 0; j < maxPoints; j++) {
        var rec = records[j];
        if (rec) {
          positions[j * 3] = rec.p.x;
          positions[j * 3 + 1] = rec.p.y;
          positions[j * 3 + 2] = rec.p.z;
          alphas[j] = clamp(1 - (clock - rec.t) / life, 0, 1);
        } else {
          positions[j * 3] = positions[j * 3 + 1] = positions[j * 3 + 2] = 0;
          alphas[j] = 0;
        }
      }
      geometry.setDrawRange(0, records.length);
      posAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
      line.visible = visible && records.length > 1;
    }

    function update(dt, explicitPosition) {
      var delta = clamp(num(dt, 0), 0, 0.25);
      clock += delta;
      sampleClock += delta;
      if (explicitPosition) append(explicitPosition, clock);
      else if (target && (sampleEvery === 0 || sampleClock >= sampleEvery)) {
        sampleClock = 0;
        append(targetResolver(), clock);
      }
      rebuild();
      return records.length;
    }

    var controller = {
      enabled: true,
      object: line,
      line: line,
      geometry: geometry,
      material: material,
      update: update,
      push: function push(position, timestamp) { if (append(position, timestamp)) rebuild(); return controller; },
      add: function add(position, timestamp) { return controller.push(position, timestamp); },
      clear: function clear() { records.length = 0; last = null; rebuild(); return controller; },
      setVisible: function setVisible(value) { visible = !!value; rebuild(); return controller; },
      setColor: function setColor(value) { if (material.uniforms && material.uniforms.uColor) material.uniforms.uColor.value = color(THREE, value, 0x4da3ff); return controller; },
      setOpacity: function setOpacity(value) { if (material.uniforms && material.uniforms.uOpacity) material.uniforms.uOpacity.value = clamp(num(value, 0.86), 0, 1); return controller; },
      setTarget: function setTarget(next) { target = next; targetResolver = typeof target === 'function' ? target : function () { return target; }; return controller; },
      dispose: function disposeTrail() {
        if (line.parent) line.parent.remove(line);
        if (geometry.dispose) geometry.dispose();
        if (material.dispose) material.dispose();
      }
    };
    return controller;
  }

  /**
   * Draw linear velocity (local +X / robot front) and angular velocity (+/-Y)
   * arrows.  Attach the returned object to a robot group for local arrows, or
   * give a scene and target for world-space arrows.  Data accepts `{v, w}` or
   * `{v, omega}`, with optional `{heading}` in radians.
   */
  function createVelocityVector(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Group || !THREE.ArrowHelper || !THREE.Vector3) {
      return noopController({ reason: 'THREE ArrowHelper unavailable' });
    }
    var target = options.target || null;
    var targetResolver = typeof target === 'function' ? target : function () { return target; };
    var group = new THREE.Group();
    group.userData = group.userData || {};
    group.userData.visualHUD = 'velocity-vector';
    var attachInfo = addToParent(group, options, target, true);
    var origin = vec(THREE, options.origin, { x: 0, y: num(options.height, 0.12), z: 0 });
    var front = vec(THREE, options.frontAxis, { x: 1, y: 0, z: 0 }).normalize();
    var linear = new THREE.ArrowHelper(front.clone(), origin.clone(), 0, color(THREE, options.color, 0x55c8ff), num(options.headLength, 0.075), num(options.headWidth, 0.045));
    var angular = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin.clone(), 0, color(THREE, options.angularColor, 0xffbf5b), num(options.angularHeadLength, 0.065), num(options.angularHeadWidth, 0.04));
    group.add(linear, angular);
    var vScale = num(options.vScale, 0.42);
    var omegaScale = num(options.omegaScale, 0.16);
    var maxLength = num(options.maxLength, 0.7);
    var visible = true;
    var lastData = { v: 0, omega: 0 };
    var tempPos = new THREE.Vector3();
    var tempForward = new THREE.Vector3();
    var tempUp = new THREE.Vector3(0, 1, 0);

    function update(data) {
      data = data || {};
      var v = num(data.v, data.velocity && data.velocity.v != null ? data.velocity.v : 0);
      var omega = num(data.omega != null ? data.omega : data.w, data.velocity && data.velocity.omega != null ? data.velocity.omega : 0);
      lastData.v = v; lastData.omega = omega;
      var t = targetResolver();
      if (!attachInfo.attached && t) {
        var p = resolvePosition(THREE, t, tempPos);
        if (p) group.position.copy(p);
      } else if (attachInfo.attached) {
        group.position.copy(origin).set(origin.x, origin.y, origin.z);
      }
      var worldSpace = !attachInfo.attached;
      if (data.heading != null) {
        tempForward.set(Math.cos(num(data.heading, 0)), 0, -Math.sin(num(data.heading, 0))).normalize();
      } else if (worldSpace && t && t.quaternion) {
        tempForward.copy(front).applyQuaternion(t.quaternion).normalize();
      } else if (worldSpace && t && (t.heading != null || t.th != null)) {
        var targetHeading = t.heading != null ? t.heading : t.th;
        tempForward.set(Math.cos(num(targetHeading, 0)), 0, -Math.sin(num(targetHeading, 0))).normalize();
      } else {
        tempForward.copy(front).normalize();
      }
      var linearLength = clamp(Math.abs(v) * vScale, 0, maxLength);
      if (v < 0) tempForward.multiplyScalar(-1);
      linear.setDirection(tempForward);
      linear.setLength(linearLength, Math.min(num(options.headLength, 0.075), linearLength * 0.6), num(options.headWidth, 0.045));
      var angularLength = clamp(Math.abs(omega) * omegaScale, 0, maxLength * 0.72);
      var angularDir = omega < 0 ? tempUp.clone().multiplyScalar(-1) : tempUp;
      angular.setDirection(angularDir);
      angular.setLength(angularLength, Math.min(num(options.angularHeadLength, 0.065), angularLength * 0.7), num(options.angularHeadWidth, 0.04));
      group.visible = visible;
      linear.visible = visible && linearLength > 0.001;
      angular.visible = visible && angularLength > 0.001;
      return lastData;
    }

    var controller = {
      enabled: true,
      object: group,
      group: group,
      linear: linear,
      angular: angular,
      update: update,
      setVisible: function setVisible(value) { visible = !!value; group.visible = visible; return controller; },
      setTarget: function setTarget(next) { target = next; targetResolver = typeof target === 'function' ? target : function () { return target; }; return controller; },
      dispose: function disposeVelocity() {
        if (group.parent) group.parent.remove(group);
        if (linear.dispose) linear.dispose();
        if (angular.dispose) angular.dispose();
      }
    };
    return controller;
  }

  function transformTarget(THREE, target, options, position, forward) {
    var source = typeof target === 'function' ? target() : target;
    if (!source) return false;
    if (source.position || source.isObject3D) {
      resolvePosition(THREE, source, position);
      forward.copy(vec(THREE, options.frontAxis, { x: 1, y: 0, z: 0 }));
      if (source.quaternion) forward.applyQuaternion(source.quaternion);
      return true;
    }
    if (source.x != null || source.y != null || source.z != null) {
      // Simulator state is normally 2D `{x, y, th}`; the 3D view maps its
      // ground-plane y coordinate to world -z.  If a caller already supplies
      // a world `z`, keep it; the vertical world coordinate remains `height`
      // (or zero) rather than accidentally reusing z.
      var worldZ = source.z != null ? num(source.z, 0) : -num(source.y, 0);
      var worldY = source.height != null ? num(source.height, 0) : num(source.worldY, 0);
      position.set(num(source.x, 0), worldY, worldZ);
      // A simulator 2D state normally stores heading in `th` and maps y → -z.
      var heading = source.heading != null ? source.heading : source.th;
      if (heading != null) forward.set(Math.cos(num(heading, 0)), 0, -Math.sin(num(heading, 0)));
      else forward.set(1, 0, 0);
      return true;
    }
    return false;
  }

  /**
   * Camera preset controller for a PerspectiveCamera or OrthographicCamera.
   * Modes: `top` (bird's-eye), `chase` (follow target), `edge` (focus nearest
   * ring edge).  `update(dt, state)` can receive `{us, them, edgePoint,
   * center}`; Object3D targets are also accepted directly in options.
   */
  function createCameraController(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Vector3 || !options.camera || typeof options.camera.lookAt !== 'function') {
      return noopController({ reason: 'THREE camera unavailable', mode: 'manual' });
    }
    var camera = options.camera;
    var mode = String(options.mode || 'manual').toLowerCase();
    var target = options.target || null;
    var targetResolver = typeof target === 'function' ? target : function () { return target; };
    var pairResolver = options.targets || null;
    var center = vec(THREE, options.center, { x: 0, y: 0, z: 0 });
    var ringHalf = num(options.ringHalfSize, num(options.ringSize, 2.4) / 2);
    var topHeight = num(options.topHeight, 4.8);
    var chaseDistance = num(options.chaseDistance, 1.5);
    var chaseHeight = num(options.chaseHeight, 0.82);
    var chaseLookAhead = num(options.chaseLookAhead, 0.5);
    var edgeDistance = num(options.edgeDistance, 1.22);
    var edgeHeight = num(options.edgeHeight, 0.86);
    var smoothing = Math.max(0, num(options.smoothing, 8));
    var active = true;
    var initialized = false;
    var desiredPos = new THREE.Vector3();
    var desiredLook = new THREE.Vector3();
    var currentLook = new THREE.Vector3();
    var tempPos = new THREE.Vector3();
    var tempForward = new THREE.Vector3();
    var temp = new THREE.Vector3();
    var up = new THREE.Vector3(0, 1, 0);

    function setTopUp() {
      // Keep north (+z) at the top of a bird's-eye image.  The small tilt is
      // only used for degenerate PerspectiveCamera lookAt math.
      if (camera.up && camera.up.set) camera.up.set(0, 0, -1);
    }

    function getPair(state) {
      var pair = typeof pairResolver === 'function' ? pairResolver(state) : pairResolver;
      if (pair && !Array.isArray(pair) && (pair.us || pair.them)) return [pair.us, pair.them];
      if (Array.isArray(pair)) return pair;
      if (state && (state.us || state.them)) return [state.us, state.them];
      return [];
    }

    function edgeFocus(state) {
      var edgePoint = state && (state.edgePoint || state.edge || state.focus);
      if (edgePoint) {
        resolvePosition(THREE, edgePoint, temp);
      } else {
        var pair = getPair(state);
        if (pair.length >= 2 && transformTarget(THREE, pair[0], options, tempPos, tempForward) && transformTarget(THREE, pair[1], options, desiredLook, temp)) {
          temp.copy(tempPos).add(desiredLook).multiplyScalar(0.5);
        } else if (pair.length && transformTarget(THREE, pair[0], options, temp, tempForward)) {
          // `temp` already contains the first target position.
        } else {
          temp.copy(center);
        }
      }
      var xDist = ringHalf - Math.abs(temp.x);
      var zDist = ringHalf - Math.abs(temp.z);
      var normal = new THREE.Vector3();
      if (xDist <= zDist) normal.set(temp.x >= 0 ? 1 : -1, 0, 0);
      else normal.set(0, 0, temp.z >= 0 ? 1 : -1);
      if (state && state.edgeNormal) normal.copy(vec(THREE, state.edgeNormal, normal)).normalize();
      return { point: temp.clone(), normal: normal };
    }

    function setMode(next, modeOptions) {
      var key = String(next || 'manual').toLowerCase();
      if (key === 'top-down' || key === 'topdown' || key === 'bird') key = 'top';
      if (key === 'chase-cam' || key === 'chasecam' || key === 'tpv') key = 'chase';
      if (key === 'edge-cam' || key === 'edgecam') key = 'edge';
      if (['manual', 'top', 'chase', 'edge'].indexOf(key) < 0) key = 'manual';
      mode = key;
      if (modeOptions && modeOptions.snap) initialized = false;
      if (mode === 'top') setTopUp();
      return controller;
    }

    function update(dt, state) {
      if (!active || mode === 'manual') return mode;
      state = state || {};
      if (state.center) center.copy(vec(THREE, state.center, center));
      if (state.ringHalfSize != null) ringHalf = num(state.ringHalfSize, ringHalf);
      var ok = true;
      if (mode === 'top') {
        desiredLook.copy(center);
        desiredPos.copy(center).add(new THREE.Vector3(0, topHeight, 0));
        setTopUp();
      } else if (mode === 'chase') {
        if (camera.up && camera.up.set) camera.up.set(0, 1, 0);
        var source = state.us || targetResolver();
        ok = transformTarget(THREE, source, options, tempPos, tempForward);
        if (ok) {
          tempForward.y = 0;
          if (tempForward.lengthSq() < 1e-8) tempForward.set(1, 0, 0);
          tempForward.normalize();
          desiredLook.copy(tempPos).add(tempForward.clone().multiplyScalar(chaseLookAhead));
          desiredLook.y += num(options.chaseLookHeight, 0.15);
          desiredPos.copy(tempPos).add(tempForward.clone().multiplyScalar(-chaseDistance));
          desiredPos.y += chaseHeight;
        }
      } else if (mode === 'edge') {
        if (camera.up && camera.up.set) camera.up.set(0, 1, 0);
        var ef = edgeFocus(state);
        desiredLook.copy(ef.point);
        desiredLook.y += num(options.edgeLookHeight, 0.08);
        desiredPos.copy(ef.point).add(ef.normal.clone().multiplyScalar(edgeDistance));
        desiredPos.y += edgeHeight;
      }
      if (!ok) return mode;
      var delta = Math.max(0, num(dt, 0));
      var blend = initialized && smoothing > 0 ? 1 - Math.exp(-smoothing * delta) : 1;
      if (!initialized || blend >= 0.999) {
        camera.position.copy(desiredPos);
        currentLook.copy(desiredLook);
        initialized = true;
      } else {
        camera.position.lerp(desiredPos, blend);
        currentLook.lerp(desiredLook, blend);
      }
      camera.lookAt(currentLook);
      if (camera.isOrthographicCamera && camera.updateProjectionMatrix) camera.updateProjectionMatrix();
      return mode;
    }

    var controller = {
      enabled: true,
      object: camera,
      camera: camera,
      mode: mode,
      update: update,
      setMode: function setCameraMode(next, modeOptions) { setMode(next, modeOptions); controller.mode = mode; return controller; },
      getMode: function getMode() { return mode; },
      setTarget: function setTarget(next) { target = next; targetResolver = typeof target === 'function' ? target : function () { return target; }; return controller; },
      setCenter: function setCenter(next) { center.copy(vec(THREE, next, center)); return controller; },
      setEnabled: function setEnabled(value) { active = !!value; return controller; },
      setVisible: function setVisible(value) { active = !!value; return controller; },
      dispose: function disposeCamera() { active = false; }
    };
    return controller;
  }

  function makeRadialTexture(THREE, options) {
    options = options || {};
    if (!THREE || !THREE.CanvasTexture) return null;
    var canvas = makeCanvas(num(options.size, 96), num(options.size, 96));
    if (!canvas) return null;
    var ctx = canvas.getContext('2d');
    var g = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width / 2);
    var c = color(THREE, options.color, 0xffffff);
    var css = '#' + c.getHexString();
    g.addColorStop(0, css);
    g.addColorStop(0.25, css);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    var texture = new THREE.CanvasTexture(canvas);
    setTextureColorSpace(THREE, texture);
    return texture;
  }

  function orientHorizontal(THREE, object, normal) {
    if (!object || !object.quaternion || !THREE || !THREE.Vector3) return;
    var n = vec(THREE, normal, { x: 0, y: 1, z: 0 }).normalize();
    // THREE.RingGeometry is authored in the XY plane, so its face normal is
    // +Z.  Rotate that normal onto the sensor target surface normal; using +Y
    // here would leave the default ripple vertical instead of on the mat.
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }

  /**
   * Sensor hit visualizer.  `emit({position, normal, color, sensorType,
   * intensity})` spawns a short glow spot and an expanding ripple.  `trigger`
   * is a compact alias: `trigger(sensorId, position, {type:'gray'})`.
   */
  function createSensorFeedback(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Group || !THREE.RingGeometry || !THREE.MeshBasicMaterial || !THREE.Sprite || !THREE.SpriteMaterial) {
      return noopController({ reason: 'THREE sensor feedback classes unavailable' });
    }
    var group = new THREE.Group();
    group.userData = group.userData || {};
    group.userData.visualHUD = 'sensor-feedback';
    var parent = options.parent || options.scene || null;
    if (parent && parent.add) parent.add(group);
    var maxWaves = clamp(Math.round(num(options.maxWaves, 32)), 1, 256);
    var maxSpots = clamp(Math.round(num(options.maxSpots, 32)), 1, 256);
    var waveGeometry = new THREE.RingGeometry(num(options.innerRadius, 0.018), num(options.outerRadius, 0.03), Math.max(12, Math.round(num(options.segments, 32))));
    var sharedTexture = makeRadialTexture(THREE, { size: num(options.textureSize, 96), color: 0xffffff });
    var waves = [], spots = [], visible = true;
    var sensorColors = { gray: 0xffd166, ir_edge: 0xff9f43, ir_distance: 0x46e0a0, vision: 0x4da3ff, default: 0x65d9ff };

    function eventColor(event) {
      if (event && event.color != null) return color(THREE, event.color, sensorColors.default);
      var type = String(event && (event.sensorType || event.type || event.kind) || 'default').toLowerCase();
      return color(THREE, sensorColors[type] == null ? sensorColors.default : sensorColors[type], sensorColors.default);
    }

    function trim(list, max) {
      while (list.length >= max) {
        var old = list.shift();
        if (old.group && old.group.parent) old.group.parent.remove(old.group);
        if (old.ringMaterial && old.ringMaterial.dispose) old.ringMaterial.dispose();
        if (old.spriteMaterial && old.spriteMaterial.dispose) old.spriteMaterial.dispose();
      }
    }

    function emit(event) {
      event = event || {};
      var p = resolvePosition(THREE, event.position || event.point || event, new THREE.Vector3());
      if (!p) return controller;
      var c = eventColor(event);
      var strength = clamp(num(event.intensity, 1), 0.1, 4);
      var life = clamp(num(event.life, 0.48), 0.08, 4);
      var effect = new THREE.Group();
      effect.position.copy(p);
      orientHorizontal(THREE, effect, event.normal || { x: 0, y: 1, z: 0 });
      group.add(effect);
      if (event.ripple !== false) {
        trim(waves, maxWaves);
        var ringMaterial = new THREE.MeshBasicMaterial({
          color: c, transparent: true, opacity: clamp(0.76 * strength, 0, 1),
          depthWrite: false, depthTest: options.depthTest !== false,
          blending: THREE.AdditiveBlending != null ? THREE.AdditiveBlending : THREE.NormalBlending,
          side: THREE.DoubleSide
        });
        var ring = new THREE.Mesh(waveGeometry, ringMaterial);
        ring.scale.setScalar(num(event.startScale, 0.65));
        effect.add(ring);
        waves.push({ group: effect, ring: ring, ringMaterial: ringMaterial, age: 0, life: life, start: num(event.startScale, 0.65), end: num(event.endScale, 2.4) });
      }
      if (event.spot !== false && sharedTexture) {
        trim(spots, maxSpots);
        var spriteMaterial = new THREE.SpriteMaterial({
          map: sharedTexture, color: c, transparent: true, opacity: clamp(0.65 * strength, 0, 1),
          depthWrite: false, depthTest: options.depthTest !== false,
          blending: THREE.AdditiveBlending != null ? THREE.AdditiveBlending : THREE.NormalBlending
        });
        var sprite = new THREE.Sprite(spriteMaterial);
        var size = num(event.spotSize, 0.13) * (0.85 + strength * 0.25);
        sprite.scale.set(size, size, 1);
        sprite.position.y += num(event.spotHeight, 0.01);
        effect.add(sprite);
        spots.push({ group: effect, sprite: sprite, spriteMaterial: spriteMaterial, age: 0, life: life * 0.72, size: size });
      }
      return controller;
    }

    function update(dt) {
      var delta = clamp(num(dt, 0), 0, 0.25);
      var i, w, s, f;
      for (i = waves.length - 1; i >= 0; i--) {
        w = waves[i]; w.age += delta; f = clamp(w.age / w.life, 0, 1);
        w.ring.scale.setScalar(w.start + (w.end - w.start) * f);
        w.ringMaterial.opacity = clamp(0.76 * (1 - f), 0, 1);
        if (w.age >= w.life) {
          if (w.group.parent) w.group.parent.remove(w.group);
          if (w.ringMaterial.dispose) w.ringMaterial.dispose();
          waves.splice(i, 1);
        }
      }
      // A spot is stored with the same group as its ripple; remove it only
      // after both lifetimes expire.  This keeps one event compact in scene.
      for (i = spots.length - 1; i >= 0; i--) {
        s = spots[i]; s.age += delta; f = clamp(s.age / s.life, 0, 1);
        s.spriteMaterial.opacity = clamp(0.65 * (1 - f), 0, 1);
        s.sprite.scale.setScalar(s.size * (1 + f * 0.35));
        if (s.age >= s.life) {
          if (s.group.parent) s.group.parent.remove(s.group);
          if (s.spriteMaterial.dispose) s.spriteMaterial.dispose();
          spots.splice(i, 1);
        }
      }
      group.visible = visible;
      return waves.length + spots.length;
    }

    function clear() {
      var list = waves.concat(spots);
      for (var i = 0; i < list.length; i++) {
        if (list[i].group && list[i].group.parent) list[i].group.parent.remove(list[i].group);
        if (list[i].ringMaterial && list[i].ringMaterial.dispose) list[i].ringMaterial.dispose();
        if (list[i].spriteMaterial && list[i].spriteMaterial.dispose) list[i].spriteMaterial.dispose();
      }
      waves.length = 0; spots.length = 0;
      return controller;
    }

    var controller = {
      enabled: true,
      object: group,
      group: group,
      update: update,
      emit: emit,
      trigger: function trigger(sensorId, position, eventOptions) {
        var event = Object.assign({}, eventOptions || {}, { sensorId: sensorId, position: position });
        return emit(event);
      },
      pulse: emit,
      clear: clear,
      setVisible: function setVisible(value) { visible = !!value; group.visible = visible; return controller; },
      dispose: function disposeFeedback() {
        clear();
        if (group.parent) group.parent.remove(group);
        if (waveGeometry.dispose) waveGeometry.dispose();
        if (sharedTexture && sharedTexture.dispose) sharedTexture.dispose();
      }
    };
    return controller;
  }

  return {
    version: '1.0.0',
    createOverheadHUD: createOverheadHUD,
    createHUD: createOverheadHUD,
    createTrail: createTrail,
    createVelocityVector: createVelocityVector,
    createVelocityVectors: createVelocityVector,
    createCameraController: createCameraController,
    createCameraPresets: createCameraController,
    createSensorFeedback: createSensorFeedback,
    createSensorFX: createSensorFeedback,
    _getThree: getThree
  };
}));
