/*
 * VisualEffects - optional Three.js presentation helpers
 *
 * This file deliberately has no dependency on the simulator CORE or on DOM
 * elements.  Load it after three.min.js when available:
 *
 *   <script src="visual_effects.js"></script>
 *   const fx = VisualEffects;
 *   fx.configureRenderer(renderer, { exposure: 1.08 });
 *
 * Every factory is safe to call when THREE is missing (for example in the
 * headless Node test runner).  In that case it returns a small no-op object
 * instead of throwing, so the deterministic decision simulator is unaffected.
 */
(function installVisualEffects(root, factory) {
  var api = factory(root);
  if (root) root.VisualEffects = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function createVisualEffects(root) {
  'use strict';

  var TAU = Math.PI * 2;
  var DEFAULT_STATE_COLORS = {
    idle: 0x7e8794,
    search: 0x3a9dff,
    attacking: 0xff334d,
    attack: 0xff334d,
    recover: 0xb36cff,
    recovery: 0xb36cff,
    disabled: 0x50545d,
    success: 0x44e38a
  };

  function getThree(explicit) {
    return explicit || (root && root.THREE) || null;
  }

  function noop() {}

  function noopController(extra) {
    var result = {
      enabled: false,
      object: null,
      update: noop,
      dispose: noop,
      setState: noop,
      emit: noop,
      render: noop,
      setSize: noop
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) result[key] = extra[key];
      }
    }
    return result;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberOr(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function colorValue(THREE, value, fallback) {
    var out = value == null ? fallback : value;
    if (THREE && THREE.Color && out && out.isColor) return out;
    if (THREE && THREE.Color) {
      try { return new THREE.Color(out == null ? fallback : out); } catch (_) {}
    }
    return out;
  }

  function disposeMaterial(material) {
    if (!material) return;
    var maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap'];
    for (var i = 0; i < maps.length; i++) {
      var texture = material[maps[i]];
      if (texture && typeof texture.dispose === 'function') texture.dispose();
    }
    if (typeof material.dispose === 'function') material.dispose();
  }

  function configureRenderer(renderer, options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!renderer) return { enabled: false, renderer: renderer || null };

    // ACES is available in r137+; retaining the old renderer value keeps the
    // helper compatible with older embedded Three.js builds.
    if (THREE && THREE.ACESFilmicToneMapping != null) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    renderer.toneMappingExposure = numberOr(options.exposure, numberOr(renderer.toneMappingExposure, 1));
    if (options.physicallyCorrectLights != null) renderer.physicallyCorrectLights = !!options.physicallyCorrectLights;

    if (THREE && THREE.SRGBColorSpace && 'outputColorSpace' in renderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if (THREE && THREE.sRGBEncoding != null && 'outputEncoding' in renderer) {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }

    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = options.shadows !== false;
      var shadowType = options.shadowType === 'vsm' ?
        (THREE && THREE.VSMShadowMap) : (THREE && THREE.PCFSoftShadowMap);
      if (shadowType != null) renderer.shadowMap.type = shadowType;
      if (options.autoUpdateShadows != null) renderer.shadowMap.autoUpdate = !!options.autoUpdateShadows;
    }
    return {
      enabled: true,
      renderer: renderer,
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      shadowType: renderer.shadowMap && renderer.shadowMap.type
    };
  }

  function hashNoise(x, y, seed) {
    // Deterministic value noise.  It intentionally does not use Math.random,
    // which keeps screenshots/replays stable across a run.
    var n = Math.sin((x * 127.1 + y * 311.7 + seed * 74.7)) * 43758.5453;
    return n - Math.floor(n);
  }

  function textureSettings(texture, options) {
    options = options || {};
    if (!texture) return texture;
    var THREE = getThree(options.THREE);
    if (THREE && THREE.RepeatWrapping != null) {
      texture.wrapS = options.wrapS == null ? THREE.RepeatWrapping : options.wrapS;
      texture.wrapT = options.wrapT == null ? THREE.RepeatWrapping : options.wrapT;
    }
    if (texture.repeat && typeof texture.repeat.set === 'function') {
      texture.repeat.set(numberOr(options.repeatX, numberOr(options.repeat, 1)),
        numberOr(options.repeatY, numberOr(options.repeat, 1)));
    }
    if (texture.colorSpace != null && THREE && THREE.NoColorSpace) texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  function dataTexture(THREE, data, width, height, options) {
    if (!THREE || !THREE.DataTexture) return null;
    var format = THREE.RGBAFormat != null ? THREE.RGBAFormat : undefined;
    var type = THREE.UnsignedByteType != null ? THREE.UnsignedByteType : undefined;
    var texture;
    try {
      texture = new THREE.DataTexture(data, width, height, format, type);
    } catch (_) {
      try { texture = new THREE.DataTexture(data, width, height); } catch (__) { return null; }
    }
    return textureSettings(texture, options);
  }

  /**
   * Build deterministic color/normal/roughness micro-textures in memory.
   * No image file or network request is made.  Returned maps can be passed
   * directly to MeshStandardMaterial/MeshPhysicalMaterial.
   */
  function createProceduralMaps(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.DataTexture) {
      return { enabled: false, width: 0, height: 0, colorMap: null, normalMap: null, roughnessMap: null, dispose: noop };
    }
    var size = clamp(Math.round(numberOr(options.size, 64)), 8, 512);
    // Keep power-of-two dimensions for old WebGL implementations.
    var width = 1;
    while (width < size) width *= 2;
    var height = width;
    var seed = numberOr(options.seed, 17);
    var base = colorValue(THREE, options.color, 0x707782);
    var r0 = base && base.r != null ? Math.round(clamp(base.r, 0, 1) * 255) : ((Number(base) >> 16) & 255);
    var g0 = base && base.g != null ? Math.round(clamp(base.g, 0, 1) * 255) : ((Number(base) >> 8) & 255);
    var b0 = base && base.b != null ? Math.round(clamp(base.b, 0, 1) * 255) : (Number(base) & 255);
    if (!Number.isFinite(r0)) r0 = 112;
    if (!Number.isFinite(g0)) g0 = 119;
    if (!Number.isFinite(b0)) b0 = 130;
    var colorData = new Uint8Array(width * height * 4);
    var normalData = new Uint8Array(width * height * 4);
    var roughData = new Uint8Array(width * height * 4);
    var heights = new Float32Array(width * height);
    var roughness = clamp(numberOr(options.roughness, 0.78), 0.05, 1);
    var contrast = clamp(numberOr(options.contrast, 0.18), 0, 1);
    var normalStrength = clamp(numberOr(options.normalStrength, 1.3), 0, 5);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var i = y * width + x;
        var coarse = hashNoise(Math.floor(x / 5), Math.floor(y / 5), seed);
        var fine = hashNoise(x, y, seed + 11);
        var grain = (coarse * 0.7 + fine * 0.3) - 0.5;
        var h = clamp(0.5 + grain * 0.9, 0, 1);
        heights[i] = h;
        var shade = 1 + grain * contrast;
        colorData[i * 4] = Math.round(clamp(r0 * shade, 0, 255));
        colorData[i * 4 + 1] = Math.round(clamp(g0 * shade, 0, 255));
        colorData[i * 4 + 2] = Math.round(clamp(b0 * shade, 0, 255));
        colorData[i * 4 + 3] = 255;
        var rough = clamp(roughness + grain * 0.22, 0, 1);
        roughData[i * 4] = roughData[i * 4 + 1] = roughData[i * 4 + 2] = Math.round(rough * 255);
        roughData[i * 4 + 3] = 255;
      }
    }
    for (var yy = 0; yy < height; yy++) {
      for (var xx = 0; xx < width; xx++) {
        var idx = yy * width + xx;
        var left = heights[yy * width + ((xx + width - 1) % width)];
        var right = heights[yy * width + ((xx + 1) % width)];
        var up = heights[((yy + height - 1) % height) * width + xx];
        var down = heights[((yy + 1) % height) * width + xx];
        var nx = clamp((left - right) * normalStrength + 0.5, 0, 1);
        var ny = clamp((up - down) * normalStrength + 0.5, 0, 1);
        var ni = idx * 4;
        normalData[ni] = Math.round(nx * 255);
        normalData[ni + 1] = Math.round(ny * 255);
        normalData[ni + 2] = 255;
        normalData[ni + 3] = 255;
      }
    }
    var mapOptions = { THREE: THREE, repeat: numberOr(options.repeat, 1) };
    var maps = {
      enabled: true,
      width: width,
      height: height,
      colorMap: dataTexture(THREE, colorData, width, height, mapOptions),
      normalMap: dataTexture(THREE, normalData, width, height, mapOptions),
      roughnessMap: dataTexture(THREE, roughData, width, height, mapOptions),
      dispose: function disposeMaps() {
        if (maps.colorMap && maps.colorMap.dispose) maps.colorMap.dispose();
        if (maps.normalMap && maps.normalMap.dispose) maps.normalMap.dispose();
        if (maps.roughnessMap && maps.roughnessMap.dispose) maps.roughnessMap.dispose();
      }
    };
    // Base-color maps are authored in sRGB; normal/roughness stay linear.
    if (maps.colorMap) {
      if (THREE.SRGBColorSpace && 'colorSpace' in maps.colorMap) maps.colorMap.colorSpace = THREE.SRGBColorSpace;
      else if (THREE.sRGBEncoding != null && 'encoding' in maps.colorMap) maps.colorMap.encoding = THREE.sRGBEncoding;
      maps.colorMap.needsUpdate = true;
    }
    if (maps.normalMap && THREE.Vector2) maps.normalScale = new THREE.Vector2(numberOr(options.normalScale, 0.55), numberOr(options.normalScale, 0.55));
    return maps;
  }

  function createPBRMaterial(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE) return null;
    var maps = options.maps || createProceduralMaps(options);
    var Material = options.physical !== false && THREE.MeshPhysicalMaterial ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
    if (!Material) return null;
    var params = {};
    if (options.color != null) params.color = colorValue(THREE, options.color, 0xffffff);
    if (options.map || maps.colorMap) params.map = options.map || maps.colorMap;
    if (options.normalMap || maps.normalMap) params.normalMap = options.normalMap || maps.normalMap;
    if (options.roughnessMap || maps.roughnessMap) params.roughnessMap = options.roughnessMap || maps.roughnessMap;
    if (options.aoMap || maps.aoMap) params.aoMap = options.aoMap || maps.aoMap;
    params.roughness = clamp(numberOr(options.roughness, 0.72), 0.02, 1);
    params.metalness = clamp(numberOr(options.metalness, 0.08), 0, 1);
    if (options.emissive != null) params.emissive = colorValue(THREE, options.emissive, 0x000000);
    if (options.emissiveIntensity != null) params.emissiveIntensity = Math.max(0, Number(options.emissiveIntensity));
    if (options.transparent != null) params.transparent = !!options.transparent;
    if (options.opacity != null) params.opacity = clamp(Number(options.opacity), 0, 1);
    var material;
    try { material = new Material(params); } catch (_) { return null; }
    if (maps.normalScale && material.normalScale && material.normalScale.copy) material.normalScale.copy(maps.normalScale);
    material.userData = material.userData || {};
    material.userData.visualEffects = { maps: maps };
    return material;
  }

  function makeRadialTexture(THREE, options) {
    options = options || {};
    if (!THREE || !THREE.DataTexture) return null;
    var size = clamp(Math.round(numberOr(options.size, 64)), 8, 256);
    var data = new Uint8Array(size * size * 4);
    var inner = clamp(numberOr(options.inner, 0.1), 0, 1);
    var power = Math.max(0.1, numberOr(options.power, 2.4));
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var dx = (x + 0.5) / size * 2 - 1;
        var dy = (y + 0.5) / size * 2 - 1;
        var d = Math.sqrt(dx * dx + dy * dy);
        var a = d >= 1 ? 0 : Math.pow(clamp((1 - d) / (1 - inner), 0, 1), power);
        var i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    return dataTexture(THREE, data, size, size, { THREE: THREE, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
  }

  /** Add a soft circular receiver decal below a vehicle or prop. */
  function createContactShadow(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Mesh || !THREE.PlaneGeometry || !THREE.MeshBasicMaterial) return noopController();
    var texture = options.texture || makeRadialTexture(THREE, { size: options.textureSize || 64, power: options.power || 1.8 });
    var material = new THREE.MeshBasicMaterial({
      map: texture,
      color: colorValue(THREE, options.color, 0x080b10),
      transparent: true,
      opacity: clamp(numberOr(options.opacity, 0.34), 0, 1),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide
    });
    var size = numberOr(options.size, 0.42);
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = numberOr(options.renderOrder, 1);
    mesh.userData = mesh.userData || {};
    mesh.userData.visualEffects = 'contact-shadow';
    var parent = options.parent || options.scene;
    if (parent && parent.add) parent.add(mesh);
    var target = options.target || null;
    var y = numberOr(options.y, 0.004);
    var offsetX = numberOr(options.offsetX, 0);
    var offsetZ = numberOr(options.offsetZ, 0);
    var update = function updateContactShadow() {
      if (!target || !target.position) return;
      mesh.position.set(target.position.x + offsetX, y, target.position.z + offsetZ);
      if (options.followRotation && target.rotation) mesh.rotation.z = target.rotation.y;
    };
    update();
    return {
      enabled: true,
      object: mesh,
      texture: texture,
      update: update,
      setOpacity: function setOpacity(value) { material.opacity = clamp(Number(value), 0, 1); },
      dispose: function disposeContactShadow() {
        if (mesh.parent) mesh.parent.remove(mesh);
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        disposeMaterial(material);
      }
    };
  }

  // AO decal uses the same cheap radial receiver but exposes a semantic name
  // for callers that want to place one at a 6cm step or wheel footprint.
  function createAODecal(options) {
    options = Object.assign({}, options || {});
    if (options.opacity == null) options.opacity = 0.22;
    if (options.size == null) options.size = 0.28;
    return createContactShadow(options);
  }

  function createGlowSprite(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Sprite || !THREE.SpriteMaterial) return noopController();
    var texture = options.texture || makeRadialTexture(THREE, { size: options.textureSize || 64, power: options.power || 2.2 });
    var material = new THREE.SpriteMaterial({
      map: texture,
      color: colorValue(THREE, options.color, 0x55aaff),
      transparent: true,
      opacity: clamp(numberOr(options.opacity, 0.72), 0, 1),
      depthWrite: false,
      blending: THREE.AdditiveBlending != null ? THREE.AdditiveBlending : undefined
    });
    var sprite = new THREE.Sprite(material);
    var size = numberOr(options.size, 0.24);
    if (sprite.scale && sprite.scale.set) sprite.scale.set(size, size, 1);
    if (options.position && sprite.position && sprite.position.copy) sprite.position.copy(options.position);
    var parent = options.parent || options.scene;
    if (parent && parent.add) parent.add(sprite);
    return {
      enabled: true,
      object: sprite,
      material: material,
      setColor: function setColor(value) { if (material.color && material.color.set) material.color.set(value); },
      setOpacity: function setOpacity(value) { material.opacity = clamp(Number(value), 0, 1); },
      dispose: function disposeGlow() {
        if (sprite.parent) sprite.parent.remove(sprite);
        disposeMaterial(material);
      }
    };
  }

  /**
   * Build a breathing/flickering status indicator.  Attach controller.object
   * to a robot group and call controller.update(dt) from the render loop.
   */
  function createStatusLight(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Mesh || !THREE.SphereGeometry || !THREE.MeshStandardMaterial) return noopController();
    var color = colorValue(THREE, options.color, DEFAULT_STATE_COLORS.idle);
    var material = new THREE.MeshStandardMaterial({
      color: color,
      emissive: color,
      emissiveIntensity: numberOr(options.emissiveIntensity, 1.8),
      roughness: 0.28,
      metalness: 0.05
    });
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(numberOr(options.radius, 0.025), 12, 8), material);
    mesh.userData = mesh.userData || {};
    mesh.userData.visualEffects = 'status-light';
    if (options.position && mesh.position && mesh.position.copy) mesh.position.copy(options.position);
    var parent = options.parent;
    if (parent && parent.add) parent.add(mesh);
    var light = null;
    if (options.pointLight !== false && THREE.PointLight) {
      light = new THREE.PointLight(color, numberOr(options.lightIntensity, 0.42), numberOr(options.distance, 0.55), numberOr(options.decay, 2));
      light.position.copy(mesh.position);
      if (parent && parent.add) parent.add(light);
    }
    var state = String(options.state || 'idle').toLowerCase();
    var elapsed = 0;
    var visible = true;
    var controller = {
      enabled: true,
      object: mesh,
      light: light,
      state: state,
      setState: function setState(next, overrideColor) {
        state = String(next || 'idle').toLowerCase();
        controller.state = state;
        var c = colorValue(THREE, overrideColor != null ? overrideColor : DEFAULT_STATE_COLORS[state] || DEFAULT_STATE_COLORS.idle, DEFAULT_STATE_COLORS.idle);
        if (material.color && material.color.copy) material.color.copy(c); else if (material.color && material.color.set) material.color.set(c);
        if (material.emissive && material.emissive.copy) material.emissive.copy(c); else if (material.emissive && material.emissive.set) material.emissive.set(c);
        if (light && light.color) {
          if (light.color.copy) light.color.copy(c); else if (light.color.set) light.color.set(c);
        }
        return controller;
      },
      update: function updateStatusLight(dt) {
        if (!visible) return;
        elapsed += Math.max(0, numberOr(dt, 0));
        var wave = 0.5 + 0.5 * Math.sin(elapsed * TAU * (state === 'attacking' || state === 'attack' ? 5.5 : 1.25));
        var intensity = 0.72;
        if (state === 'search') intensity = 0.62 + wave * 0.78;
        else if (state === 'attacking' || state === 'attack') intensity = wave > 0.48 ? 2.8 : 0.12;
        else if (state === 'recover' || state === 'recovery') intensity = 0.45 + wave * 1.45;
        else if (state === 'disabled') intensity = 0.05;
        else intensity = 0.46 + wave * 0.45;
        material.emissiveIntensity = intensity;
        if (light) light.intensity = intensity * numberOr(options.lightScale, 0.24);
        if (mesh.scale && mesh.scale.setScalar) mesh.scale.setScalar(0.92 + wave * 0.1);
      },
      setVisible: function setVisible(value) {
        visible = !!value;
        mesh.visible = visible;
        if (light) light.visible = visible;
      },
      dispose: function disposeStatusLight() {
        if (mesh.parent) mesh.parent.remove(mesh);
        if (light && light.parent) light.parent.remove(light);
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        disposeMaterial(material);
      }
    };
    controller.setState(state);
    return controller;
  }

  function vec3(THREE, value, fallback) {
    if (value && value.isVector3) return value.clone ? value.clone() : value;
    var source = value || fallback || { x: 0, y: 0, z: 0 };
    return THREE && THREE.Vector3 ? new THREE.Vector3(numberOr(source.x, 0), numberOr(source.y, 0), numberOr(source.z, 0)) : source;
  }

  /** Lightweight pooled dust emitter for impacts/acceleration feedback. */
  function createDustEmitter(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.BufferGeometry || !THREE.Points || !THREE.PointsMaterial) return noopController();
    var max = clamp(Math.round(numberOr(options.maxParticles, 180)), 8, 2000);
    var positions = new Float32Array(max * 3);
    var colors = new Float32Array(max * 3);
    var particles = [];
    var i;
    for (i = 0; i < max; i++) {
      positions[i * 3] = positions[i * 3 + 1] = positions[i * 3 + 2] = 9999;
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0;
      particles.push({ alive: false, age: 0, life: 0, vx: 0, vy: 0, vz: 0 });
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    var material = new THREE.PointsMaterial({
      color: colorValue(THREE, options.color, 0xc4a27a),
      size: numberOr(options.size, 0.035),
      sizeAttenuation: true,
      transparent: true,
      opacity: clamp(numberOr(options.opacity, 0.52), 0, 1),
      depthWrite: false,
      vertexColors: true
    });
    var points = new THREE.Points(geometry, material);
    points.userData = points.userData || {};
    points.userData.visualEffects = 'dust-emitter';
    var parent = options.parent || options.scene;
    if (parent && parent.add) parent.add(points);
    var cursor = 0;
    var gravity = numberOr(options.gravity, -0.22);
    var emitter = {
      enabled: true,
      object: points,
      emit: function emit(position, velocity, count) {
        var p = vec3(THREE, position, { x: 0, y: 0, z: 0 });
        var v = vec3(THREE, velocity, { x: 0, y: 0.12, z: 0 });
        var amount = clamp(Math.round(numberOr(count, 8)), 1, max);
        for (var n = 0; n < amount; n++) {
          var index = cursor++ % max;
          var particle = particles[index];
          var spread = numberOr(options.spread, 0.16);
          particle.alive = true;
          particle.age = 0;
          particle.life = numberOr(options.life, 0.42) * (0.72 + hashNoise(n, index, 31) * 0.5);
          particle.vx = v.x + (hashNoise(index, n, 7) - 0.5) * spread;
          particle.vy = v.y + hashNoise(index, n, 13) * spread;
          particle.vz = v.z + (hashNoise(index, n, 19) - 0.5) * spread;
          positions[index * 3] = p.x + (hashNoise(index, n, 23) - 0.5) * spread * 0.4;
          positions[index * 3 + 1] = p.y + hashNoise(index, n, 29) * spread * 0.25;
          positions[index * 3 + 2] = p.z + (hashNoise(index, n, 37) - 0.5) * spread * 0.4;
          colors[index * 3] = colors[index * 3 + 1] = colors[index * 3 + 2] = 1;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;
      },
      update: function updateDust(dt) {
        var delta = clamp(numberOr(dt, 0), 0, 0.1);
        for (var n = 0; n < max; n++) {
          var particle = particles[n];
          if (!particle.alive) continue;
          particle.age += delta;
          if (particle.age >= particle.life) {
            particle.alive = false;
            positions[n * 3] = positions[n * 3 + 1] = positions[n * 3 + 2] = 9999;
            colors[n * 3] = colors[n * 3 + 1] = colors[n * 3 + 2] = 0;
            continue;
          }
          positions[n * 3] += particle.vx * delta;
          positions[n * 3 + 1] += particle.vy * delta;
          positions[n * 3 + 2] += particle.vz * delta;
          particle.vy += gravity * delta;
          var fade = 1 - particle.age / particle.life;
          colors[n * 3] = colors[n * 3 + 1] = colors[n * 3 + 2] = fade;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.color.needsUpdate = true;
      },
      dispose: function disposeDust() {
        if (points.parent) points.parent.remove(points);
        if (geometry.dispose) geometry.dispose();
        disposeMaterial(material);
      }
    };
    return emitter;
  }

  /** Place a short-lived dark translucent strip where a wheel skids. */
  function createTireMark(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    if (!THREE || !THREE.Mesh || !THREE.PlaneGeometry || !THREE.MeshBasicMaterial) return noopController();
    var material = new THREE.MeshBasicMaterial({
      color: colorValue(THREE, options.color, 0x111318),
      transparent: true,
      opacity: clamp(numberOr(options.opacity, 0.28), 0, 1),
      depthWrite: false,
      side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(numberOr(options.width, 0.035), numberOr(options.length, 0.24)), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = numberOr(options.y, 0.006);
    if (options.position && mesh.position.copy) mesh.position.copy(options.position);
    if (options.rotation != null) mesh.rotation.z = Number(options.rotation);
    var parent = options.parent || options.scene;
    if (parent && parent.add) parent.add(mesh);
    var ttl = Math.max(0, numberOr(options.life, 2.8));
    var age = 0;
    return {
      enabled: true,
      object: mesh,
      update: function updateTireMark(dt) {
        age += Math.max(0, numberOr(dt, 0));
        if (ttl > 0) material.opacity = clamp(numberOr(options.opacity, 0.28) * (1 - age / ttl), 0, 1);
        if (ttl > 0 && age >= ttl) mesh.visible = false;
      },
      dispose: function disposeTireMark() {
        if (mesh.parent) mesh.parent.remove(mesh);
        if (mesh.geometry && mesh.geometry.dispose) mesh.geometry.dispose();
        disposeMaterial(material);
      }
    };
  }

  /**
   * Optional UnrealBloom post-processing bridge.  EffectComposer/RenderPass/
   * UnrealBloomPass are not bundled in this project, so the fallback simply
   * delegates to renderer.render and leaves emissive/glow materials intact.
   */
  function createBloom(options) {
    options = options || {};
    var THREE = getThree(options.THREE);
    var renderer = options.renderer;
    var scene = options.scene;
    var camera = options.camera;
    var Composer = options.EffectComposer || (root && root.EffectComposer) || (THREE && THREE.EffectComposer);
    var RenderPass = options.RenderPass || (root && root.RenderPass) || (THREE && THREE.RenderPass);
    var BloomPass = options.UnrealBloomPass || (root && root.UnrealBloomPass) || (THREE && THREE.UnrealBloomPass);
    if (!renderer || !scene || !camera || !Composer || !RenderPass || !BloomPass) {
      return noopController({
        reason: 'EffectComposer/UnrealBloomPass unavailable; emissive fallback',
        enabled: false,
        render: function renderFallback(delta) { if (renderer && renderer.render) renderer.render(scene, camera); return delta; }
      });
    }
    var composer;
    try {
      composer = new Composer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      var width = renderer.domElement ? renderer.domElement.width : 1;
      var height = renderer.domElement ? renderer.domElement.height : 1;
      var bloom = new BloomPass(new (THREE && THREE.Vector2 ? THREE.Vector2 : function Vector2(x, y) { this.x = x; this.y = y; })(width, height),
        numberOr(options.strength, 0.52), numberOr(options.radius, 0.35), numberOr(options.threshold, 0.78));
      composer.addPass(bloom);
      return {
        enabled: true,
        composer: composer,
        pass: bloom,
        render: function renderBloom(delta) { return composer.render(delta); },
        setSize: function setBloomSize(w, h) { if (composer.setSize) composer.setSize(w, h); },
        dispose: function disposeBloom() { if (composer.dispose) composer.dispose(); }
      };
    } catch (error) {
      return noopController({ reason: 'Bloom initialization failed: ' + (error && error.message || error) });
    }
  }

  return {
    version: '1.0.0',
    configureRenderer: configureRenderer,
    setupRenderer: configureRenderer,
    createProceduralMaps: createProceduralMaps,
    createMicroTexture: createProceduralMaps,
    createMicroTextures: createProceduralMaps,
    createPBRMaterial: createPBRMaterial,
    createContactShadow: createContactShadow,
    createAODecal: createAODecal,
    createSoftShadow: createContactShadow,
    createGlowSprite: createGlowSprite,
    createStatusLight: createStatusLight,
    createStatusLamp: createStatusLight,
    createDustEmitter: createDustEmitter,
    createParticleEmitter: createDustEmitter,
    createDust: createDustEmitter,
    createTireMark: createTireMark,
    createBloom: createBloom,
    createBloomPass: createBloom,
    _getThree: getThree
  };
}));
