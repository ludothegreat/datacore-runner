// @ts-check
// Datacore Runner - concept demo.
// Single file on purpose: this proves the look and the feel before any structure exists.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// ---------------------------------------------------------------- logging

const params = new URLSearchParams(location.search);
const DEBUG = !params.has('quiet');
/** @param {...unknown} args */
const dbg = (...args) => { if (DEBUG) console.debug('[datacore]', ...args); };

/** @param {string} msg */
function fatal(msg) {
  const el = document.getElementById('fatal');
  el.style.display = 'block';
  el.textContent = `datacore-runner crashed:\n\n${msg}`;
  console.error('[datacore] FATAL', msg);
}
window.addEventListener('error', (e) => fatal(`${e.message}\n${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => fatal(String(e.reason)));

// ---------------------------------------------------------------- tuning

const CFG = {
  laneWidth: 3,
  laneSnap: 16,          // higher = snappier lane change
  hoverY: 0.6,
  duckY: 0.25,
  duckTime: 0.6,
  jumpV: 11,
  gravity: 30,
  fastFallMul: 3.2,
  jumpBuffer: 0.14,      // seconds a jump press is remembered before landing
  speedStart: 34,
  speedMax: 72,
  speedAccel: 0.7,
  hitSlow: 0.55,
  hitInvuln: 1.2,
  corruptReach: 34,      // how far ahead of the dart the infection front runs
  climbSpeed: 30,        // how fast orange climbs a tower, units/s
  towerSpacing: 8,
  towerSlots: 44,
  towerRows: 4,
  histStep: 0.5,
  histLen: 256,
};

const COL = {
  green: new THREE.Color(0.10, 1.0, 0.45),
  greenHot: new THREE.Color(0.75, 1.0, 0.85),
  orange: new THREE.Color(1.0, 0.36, 0.04),
  orangeHot: new THREE.Color(1.0, 0.85, 0.6),
  red: new THREE.Color(1.0, 0.10, 0.08),
  redHot: new THREE.Color(1.0, 0.22, 0.16),
};

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
dbg('renderer', renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl1', 'dpr', renderer.getPixelRatio());

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000201);
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);

const uTime = { value: 0 };

const GLSL_HASH = /* glsl */`
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

// ---------------------------------------------------------------- holo boxes
// Every glass box in the world (towers, their inner cores, obstacles) is one
// instance in one of these. Corruption is a per-instance start time, so the
// whole infection effect costs nothing on the CPU after it is triggered.

const NEVER = 1e9;

class HoloBoxes {
  /**
   * @param {number} count
   * @param {{base: THREE.Color, hot: THREE.Color, corrupt: THREE.Color, cell?: number, brightness?: number}} opts
   */
  constructor(count, opts) {
    this.count = count;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = box.index;
    geo.setAttribute('position', box.getAttribute('position'));
    geo.setAttribute('normal', box.getAttribute('normal'));
    geo.instanceCount = count;

    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.scale = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.seed = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.corrupt = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(NEVER), 1);
    for (const a of [this.offset, this.scale, this.seed, this.corrupt]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOffset', this.offset);
    geo.setAttribute('aScale', this.scale);
    geo.setAttribute('aSeed', this.seed);
    geo.setAttribute('aCorrupt', this.corrupt);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime,
        uBase: { value: opts.base },
        uHot: { value: opts.hot },
        uCorrupt: { value: opts.corrupt },
        uCorruptHot: { value: COL.orangeHot },
        uCell: { value: opts.cell ?? 1.7 },
        uBright: { value: opts.brightness ?? 0.34 },
        uClimb: { value: CFG.climbSpeed },
      },
      vertexShader: /* glsl */`
        attribute vec3 aOffset;
        attribute vec3 aScale;
        attribute float aSeed;
        attribute float aCorrupt;
        uniform float uTime;
        varying vec2 vFace;
        varying vec2 vFaceSize;
        varying float vSeed;
        varying float vT;
        varying float vTop;
        varying vec3 vWorld;
        ${GLSL_HASH}
        void main() {
          vec3 p = position * aScale;
          vec3 n = abs(normal);
          if (n.x > 0.5) { vFace = vec2(p.z + aScale.z * 0.5, p.y); vFaceSize = aScale.zy; }
          else if (n.z > 0.5) { vFace = vec2(p.x + aScale.x * 0.5, p.y); vFaceSize = aScale.xy; }
          else { vFace = vec2(p.x + aScale.x * 0.5, p.z + aScale.z * 0.5); vFaceSize = aScale.xz; }
          vTop = n.y;
          vSeed = aSeed;
          vec3 w = p + aOffset;
          float t = uTime - aCorrupt;
          // Clamped so exp() never sees the -1e9 that uninfected boxes carry.
          vT = max(t, -1.0);
          if (t > 0.0) {
            // Horizontal slices of the box tear sideways, hard at first, then an occasional twitch.
            float amt = exp(-max(t, 0.0) * 1.8);
            float band = floor(w.y / 0.7 + uTime * 9.0);
            float h = hash(vec2(band, aSeed * 17.0));
            float shove = (hash(vec2(band * 1.3, aSeed)) - 0.5) * 3.2;
            if (h > 0.5) w.x += shove * amt;
            if (h > 0.93) w.x += shove * 0.12;
          }
          vWorld = w;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uBase;
        uniform vec3 uHot;
        uniform vec3 uCorrupt;
        uniform vec3 uCorruptHot;
        uniform float uCell;
        uniform float uBright;
        uniform float uClimb;
        varying vec2 vFace;
        varying vec2 vFaceSize;
        varying float vSeed;
        varying float vT;
        varying float vTop;
        varying vec3 vWorld;
        ${GLSL_HASH}
        void main() {
          float dist = length(vWorld - cameraPosition);
          vec2 e = min(vFace, vFaceSize - vFace);
          float ed = min(e.x, e.y);
          float edge = 1.0 - smoothstep(0.0, 0.05 + dist * 0.0012, ed);
          float edgeGlow = exp(-ed * 3.5) * 0.12;

          float glyph = 0.0;
          float colId = 0.0;
          if (vTop < 0.5) {
            vec2 cs = vec2(0.36, 0.21) * uCell;
            colId = floor(vFace.x / cs.x);
            float ch = hash(vec2(colId, vSeed * 31.0));
            float y = vFace.y + uTime * (ch - 0.55) * 1.6;
            float row = floor(y / cs.y);
            vec2 f = vec2(fract(vFace.x / cs.x), fract(y / cs.y));
            float on = step(0.52, hash(vec2(colId + vSeed * 13.0, row)));
            float wide = 0.45 + 0.4 * hash(vec2(row, colId + vSeed));
            float cell = step(0.14, f.x) * step(f.x, 0.14 + wide) * step(0.22, f.y) * step(f.y, 0.78);
            float colOn = step(0.38, ch);
            vec2 region = floor(vFace / vec2(2.6, 3.1) + vSeed);
            float regionOn = step(0.28, hash(region));
            float lum = 0.35 + 0.65 * hash(vec2(row * 0.7, colId));
            float blink = step(0.04, hash(vec2(row + floor(uTime * 6.0), colId)));
            glyph = on * cell * colOn * regionOn * lum * blink;

            vec2 pc = vFace / vec2(1.9, 1.2) + vSeed * 3.0;
            float ph = hash(floor(pc));
            vec2 pf = fract(pc);
            vec2 pb = min(pf, 1.0 - pf);
            float frame = step(0.1, pb.x) * step(0.14, pb.y) * (1.0 - step(0.14, pb.x) * step(0.2, pb.y));
            glyph += step(0.9, ph) * frame * 0.7;
          }

          float c = 0.0;
          float frontier = 0.0;
          if (vT > 0.0) {
            float tc = max(vT, 0.0);
            float front = tc * uClimb + (hash(vec2(colId, vSeed)) - 0.5) * 5.0;
            c = smoothstep(0.0, 1.5, front - vWorld.y);
            frontier = exp(-abs(front - vWorld.y) * 0.9) * exp(-tc * 0.8);
          }
          vec3 base = mix(uBase, uCorrupt, c);
          vec3 hot = mix(uHot, uCorruptHot, c);
          float flick = 1.0 - c * 0.25 * step(0.8, hash(vec2(floor(uTime * 24.0), vSeed)));

          float fade = exp(-dist * 0.0105) * smoothstep(0.8, 5.0, dist);
          // Far towers keep their outline but drop the glyph detail, which only aliases into noise out there.
          glyph *= 1.0 - smoothstep(60.0, 190.0, dist) * 0.85;
          float facing = gl_FrontFacing ? 1.0 : 0.3;
          vec3 col = base * (glyph * 1.5 + edgeGlow + 0.006) * (1.0 + c * 0.6) + hot * edge * 0.75;
          col *= facing;
          col += uCorruptHot * frontier * (0.35 + glyph);
          gl_FragColor = vec4(col * fade * flick * uBright, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  /**
   * @param {number} i
   * @param {number} x @param {number} y @param {number} z
   * @param {number} sx @param {number} sy @param {number} sz
   * @param {number} seed
   */
  set(i, x, y, z, sx, sy, sz, seed) {
    this.offset.setXYZ(i, x, y, z);
    this.scale.setXYZ(i, sx, sy, sz);
    this.seed.setX(i, seed);
    this.corrupt.setX(i, NEVER);
    this.offset.needsUpdate = this.scale.needsUpdate = this.seed.needsUpdate = this.corrupt.needsUpdate = true;
  }

  /** @param {number} i */
  hide(i) {
    this.scale.setXYZ(i, 0, 0, 0);
    this.scale.needsUpdate = true;
  }

  /** @param {number} i @param {number} t */
  infect(i, t) {
    this.corrupt.setX(i, t);
    this.corrupt.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- towers

const TOWER_COUNT = CFG.towerSlots * CFG.towerRows * 2;
const TOWER_SPAN = CFG.towerSlots * CFG.towerSpacing;
// Instance i is the glass shell, instance i + TOWER_COUNT is its inner core.
const towerBoxes = new HoloBoxes(TOWER_COUNT * 2, { base: COL.green, hot: COL.greenHot, corrupt: COL.orange });
scene.add(towerBoxes.mesh);

/** @type {{x: number, z: number, infected: boolean}[]} */
const towers = [];

/** @param {number} i @param {number} z */
function placeTower(i, z) {
  const perSide = CFG.towerSlots * CFG.towerRows;
  const side = i < perSide ? -1 : 1;
  const row = Math.floor((i % perSide) / CFG.towerSlots);
  const x = side * (9.5 + row * 7.5 + (Math.random() - 0.5) * 1.5);
  const w = 3 + Math.random() * 2.6;
  const d = 3 + Math.random() * 2.8;
  const tall = Math.random() < 0.12;
  const h = tall ? 34 + Math.random() * 22 : 6 + Math.random() * (10 + row * 9);
  const seed = Math.random() * 100;
  // Gaps in the skyline: a solid wall of glass reads as noise, and the gaps show depth.
  if (Math.random() < 0.22) {
    towerBoxes.hide(i);
    towerBoxes.hide(i + TOWER_COUNT);
    towers[i] = { x, z, infected: true };
    return;
  }
  const zj = z + (Math.random() - 0.5) * 1.5;
  towerBoxes.set(i, x, 0, zj, w, h, d, seed);
  towerBoxes.set(i + TOWER_COUNT, x, 0.3, zj, w * 0.45, h * 0.8, d * 0.45, seed + 7.3);
  towers[i] = { x, z: zj, infected: false };
}

function initTowers() {
  for (let i = 0; i < TOWER_COUNT; i++) {
    const slot = i % CFG.towerSlots;
    placeTower(i, 16 - slot * CFG.towerSpacing);
  }
  dbg('towers placed', TOWER_COUNT, 'span', TOWER_SPAN);
}

// ---------------------------------------------------------------- floor

function makeCircuitTexture() {
  const S = 1024;
  const G = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'square';
  ctx.lineJoin = 'miter';
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  // Every shape is drawn at all 9 tile offsets so the texture wraps seamlessly.
  /** @param {() => void} draw */
  const tiled = (draw) => {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.save();
        ctx.translate(ox * S, oy * S);
        draw();
        ctx.restore();
      }
    }
  };

  for (let n = 0; n < 150; n++) {
    let x = Math.floor(Math.random() * (S / G)) * G;
    let y = Math.floor(Math.random() * (S / G)) * G;
    let dir = Math.floor(Math.random() * 4) * 2;
    /** @type {number[][]} */
    const pts = [[x, y]];
    const segs = 2 + Math.floor(Math.random() * 5);
    for (let s = 0; s < segs; s++) {
      const len = (1 + Math.floor(Math.random() * 4)) * G;
      x += dirs[dir][0] * len;
      y += dirs[dir][1] * len;
      pts.push([x, y]);
      dir = (dir + (Math.random() < 0.5 ? 1 : 7)) % 8;
    }
    const a = 0.35 + Math.random() * 0.65;
    const end = pts[pts.length - 1];
    tiled(() => {
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(end[0], end[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(pts[0][0] - 3, pts[0][1] - 3, 6, 6);
    });
  }

  for (let n = 0; n < 9; n++) {
    const x = Math.floor(Math.random() * (S / G)) * G;
    const y = Math.floor(Math.random() * (S / G)) * G;
    const w = (2 + Math.floor(Math.random() * 3)) * G;
    const h = (1 + Math.floor(Math.random() * 2)) * G;
    tiled(() => {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      for (let px = x + 8; px < x + w - 4; px += 12) {
        ctx.fillRect(px, y - 7, 4, 5);
        ctx.fillRect(px, y + h + 2, 4, 5);
      }
    });
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const histData = new Float32Array(CFG.histLen);
const histTex = new THREE.DataTexture(histData, CFG.histLen, 1, THREE.RedFormat, THREE.FloatType);
histTex.wrapS = THREE.RepeatWrapping;
histTex.minFilter = histTex.magFilter = THREE.NearestFilter;
histTex.needsUpdate = true;

const FLOOR_SIZE = 700;
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
floorGeo.rotateX(-Math.PI / 2);

// Reflector takes its mirror plane from the mesh transform (local +Z), so the plane has to be
// rotated as an object. Handing it the pre-rotated floor geometry makes a vertical mirror.
const mirror = new Reflector(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), {
  textureWidth: Math.floor(window.innerWidth * renderer.getPixelRatio() * 0.5),
  textureHeight: Math.floor(window.innerHeight * renderer.getPixelRatio() * 0.5),
  color: 0x5a5a5a,
  // The stock shader overlay-blends, which leaves bright reflections at full strength, so the
  // dart's reflection outshone the dart. This one just scales, and smears vertically for gloss.
  shader: {
    name: 'GlossFloor',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
    vertexShader: /* glsl */`
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      void main() {
        vUv = textureMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      varying vec4 vUv;
      void main() {
        vec2 uv = vUv.xy / vUv.w;
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int i = -3; i <= 3; i++) {
          float w = 1.0 - abs(float(i)) * 0.22;
          acc += texture2D(tDiffuse, uv + vec2(0.0, float(i) * 0.006)).rgb * w;
          wsum += w;
        }
        vec3 refl = min(acc / wsum, vec3(1.5));
        gl_FragColor = vec4(refl * color * 0.5, 1.0);
      }
    `,
  },
  // MSAA on the half-float reflection target produced NaN texels in headless Chromium,
  // which the bloom blur then spread over the whole frame (black screen).
  multisample: 0,
});
mirror.rotation.x = -Math.PI / 2;
scene.add(mirror);

const floorMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime,
    uCircuit: { value: makeCircuitTexture() },
    uHist: { value: histTex },
    uHistStep: { value: CFG.histStep },
    uHistLen: { value: CFG.histLen },
    uDartD: { value: 0 },
    uDartX: { value: 0 },
    uDartY: { value: CFG.hoverY },
    uReach: { value: CFG.corruptReach },
    uGreen: { value: COL.green },
    uOrange: { value: COL.orange },
    uOrangeHot: { value: COL.orangeHot },
  },
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main() {
      vec4 w = modelMatrix * vec4(position, 1.0);
      vWorld = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    uniform sampler2D uCircuit;
    uniform sampler2D uHist;
    uniform float uHistStep;
    uniform float uHistLen;
    uniform float uDartD;
    uniform float uDartX;
    uniform float uDartY;
    uniform float uReach;
    uniform vec3 uGreen;
    uniform vec3 uOrange;
    uniform vec3 uOrangeHot;
    varying vec3 vWorld;

    float histAt(float k) { return texture2D(uHist, vec2((k + 0.5) / uHistLen, 0.5)).r; }

    void main() {
      vec2 p = vWorld.xz;
      float dist = length(vWorld - cameraPosition);
      float fade = exp(-dist * 0.011);
      float ax = abs(p.x);
      float aa = fwidth(p.x);

      float trace = texture2D(uCircuit, p / 28.0).r;
      float fine = texture2D(uCircuit, p / 9.0 + 0.37).r * 0.25;
      float offTrack = smoothstep(4.4, 5.2, ax);
      trace = trace * (0.25 + 0.75 * offTrack) + fine * offTrack;

      float l1 = abs(ax - 1.5);
      float l2 = abs(ax - 4.5);
      float line = (1.0 - smoothstep(0.02, 0.04 + aa, l1)) * 0.55 + (1.0 - smoothstep(0.05, 0.07 + aa, l2));
      float lglow = exp(-l2 * 4.0) * 0.22 + exp(-l1 * 7.0) * 0.07;
      float pulse = pow(clamp(0.5 + 0.5 * sin(p.y * 0.22 + uTime * 7.0), 0.0, 1.0), 12.0) * exp(-l2 * 6.0);

      // Infection. Behind the dart it follows the recorded path; ahead it fans out from the nose.
      float d = -p.y;
      float age = uDartD - d;
      float inf = 0.0;
      float core = 0.0;
      if (age > 0.0) {
        float kf = d / uHistStep;
        float pathX = mix(histAt(floor(kf)), histAt(floor(kf) + 1.0), fract(kf));
        float dx = abs(p.x - pathX);
        float w = 0.7 + min(age * 0.55, 5.5);
        float life = exp(-age * 0.022) * (1.0 - smoothstep(95.0, 120.0, age));
        inf = (1.0 - smoothstep(w * 0.5, w, dx)) * life;
        // Under an airborne dart the trail has to thin out, or it shows a hard start line.
        float lift = clamp(1.2 / (0.6 + uDartY), 0.0, 1.0);
        core = exp(-dx * dx * 5.0) * exp(-age * 0.1) * mix(lift * lift, 1.0, smoothstep(0.0, 7.0, age));
      } else {
        float a = -age;
        float dx = abs(p.x - uDartX);
        float w = 1.0 + a * 0.55;
        inf = (1.0 - smoothstep(w * 0.3, w, dx)) * (1.0 - smoothstep(uReach * 0.35, uReach, a)) * 0.9;
        float lift = clamp(1.2 / (0.6 + uDartY), 0.0, 1.0);
        core = exp(-dx * dx * 5.0) * exp(-a * 1.2) * lift * lift;
      }
      float gd = length(vec2(p.x - uDartX, age * 0.6));
      float glow = exp(-gd * gd * 0.35) * 0.55 / (0.6 + uDartY);

      vec3 lineCol = mix(uGreen, uOrange, clamp(inf * 1.4, 0.0, 1.0));
      vec3 col = lineCol * (trace * (0.6 + inf * 1.4) + line + lglow + pulse * 0.8);
      col += uOrange * (core * 0.6 + glow * 0.6 + inf * 0.03);
      col += uOrangeHot * core * core * 0.2;
      gl_FragColor = vec4(col * fade, 1.0);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.position.y = 0.01;
floor.frustumCulled = false;
scene.add(floor);

// The traces lie on the mirror itself; reflecting them would double them up.
const mirrorRender = mirror.onBeforeRender;
mirror.onBeforeRender = function (/** @type {Parameters<typeof mirrorRender>} */ ...args) {
  floor.visible = false;
  mirrorRender.apply(this, args);
  floor.visible = true;
};

// ---------------------------------------------------------------- horizon glow

function makeGlowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(cv);
}
const glowTex = makeGlowTexture();
const horizon = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, color: new THREE.Color(0.1, 0.9, 0.4), blending: THREE.AdditiveBlending,
  depthWrite: false, transparent: true, opacity: 0.3,
}));
horizon.scale.set(220, 110, 1);
scene.add(horizon);

// ---------------------------------------------------------------- the payload dart

function makeDart() {
  const N = [0, 0.02, -2.5];
  const T = [0, 0.42, 0.25];
  const B = [0, -0.2, 0.2];
  const L = [-1.0, 0, 1.05];
  const R = [1.0, 0, 1.05];
  const C = [0, 0.06, 0.45];
  const tris = [
    N, L, T, N, T, R,      // top faces
    N, B, L, N, R, B,      // belly
    T, L, C, T, C, R,      // rear top, notched
    B, C, L, B, R, C,      // rear belly
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();

  const shell = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: { uTime, uOrange: { value: COL.orange }, uHot: { value: COL.orangeHot }, uFlash: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vP;
      void main() {
        vP = position;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform vec3 uOrange;
      uniform vec3 uHot;
      uniform float uFlash;
      varying vec3 vN;
      varying vec3 vV;
      varying vec3 vP;
      ${GLSL_HASH}
      void main() {
        float fres = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
        // Dense code churning inside the glass, streaming nose to tail.
        vec2 g = vec2(vP.x * 9.0, vP.z * 5.0 - uTime * 7.0);
        vec2 id = floor(g);
        vec2 f = fract(g);
        float code = step(0.45, hash(id)) * step(0.15, f.x) * step(f.x, 0.8) * step(0.2, f.y) * step(f.y, 0.85);
        code *= 0.4 + 0.6 * hash(id + floor(uTime * 10.0));
        vec3 col = uOrange * (0.16 + code * 0.55 + fres * 0.6) + uHot * fres * fres * 0.45;
        col = mix(col, vec3(1.6, 0.25, 0.2), uFlash);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));

  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 1),
    new THREE.LineBasicMaterial({ color: new THREE.Color(1.25, 0.8, 0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );

  // Opaque dark body so the glass reads as a solid object instead of washing out over the scenery.
  const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.11, 0.012) }));
  body.scale.setScalar(1.17);
  const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.3, 0.05) }));
  core.scale.set(0.34, 0.5, 0.6);
  core.position.set(0, 0.04, 0.05);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: new THREE.Color(1.0, 0.4, 0.08), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.22,
  }));
  halo.scale.set(5, 3.2, 1);

  const group = new THREE.Group();
  group.add(body, shell, edges, core, halo);
  shell.scale.setScalar(1.2);
  edges.scale.setScalar(1.2);
  return { group, shell };
}

const dart = makeDart();
scene.add(dart.group);

// ---------------------------------------------------------------- trail fragments

const P_COUNT = 360;
const pPos = new Float32Array(P_COUNT * 3);
const pVel = new Float32Array(P_COUNT * 3);
const pLife = new Float32Array(P_COUNT);      // remaining, seconds
const pFade = new Float32Array(P_COUNT);      // 0..1 for the shader
const pSize = new Float32Array(P_COUNT);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aFade', new THREE.BufferAttribute(pFade, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
const particles = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: { uOrange: { value: COL.orange }, uHot: { value: COL.orangeHot }, uScale: { value: window.innerHeight } },
  vertexShader: /* glsl */`
    attribute float aFade;
    attribute float aSize;
    uniform float uScale;
    varying float vFade;
    void main() {
      vFade = aFade;
      vec4 mv = viewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uOrange;
    uniform vec3 uHot;
    varying float vFade;
    void main() {
      // A tall thin dash, not a dot: reads as a fragment of data shearing off.
      vec2 c = abs(gl_PointCoord - 0.5);
      if (c.x > 0.16 || c.y > 0.46 || vFade <= 0.0) discard;
      gl_FragColor = vec4(mix(uOrange, uHot, vFade * vFade * 0.5) * vFade * 0.7, 1.0);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}));
particles.frustumCulled = false;
scene.add(particles);
let pNext = 0;
let pDebt = 0;

/** @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz @param {number} life @param {number} size */
function spawnParticle(x, y, z, vx, vy, vz, life, size) {
  const i = pNext;
  pNext = (pNext + 1) % P_COUNT;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
  pLife[i] = life;
  pSize[i] = size;
  pGeo.getAttribute('aSize').needsUpdate = true;
}

/** @param {number} dt */
function updateParticles(dt) {
  for (let i = 0; i < P_COUNT; i++) {
    if (pLife[i] <= 0) { pFade[i] = 0; continue; }
    pLife[i] -= dt;
    pPos[i * 3] += pVel[i * 3] * dt;
    pPos[i * 3 + 1] = Math.max(0.03, pPos[i * 3 + 1] + pVel[i * 3 + 1] * dt);
    pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    pFade[i] = Math.max(0, Math.min(1, pLife[i] * 2.2));
  }
  pGeo.getAttribute('position').needsUpdate = true;
  pGeo.getAttribute('aFade').needsUpdate = true;
}

// ---------------------------------------------------------------- obstacles

const OBS_SLOTS = 12;
const OBS_BOXES = 3;
const obsBoxes = new HoloBoxes(OBS_SLOTS * OBS_BOXES, { base: COL.red, hot: COL.redHot, corrupt: COL.orange, cell: 0.8, brightness: 1.0 });
scene.add(obsBoxes.mesh);

const TRACK_HALF = CFG.laneWidth * 1.5;

/**
 * @typedef {{active: boolean, type: 'block'|'low'|'high', z: number, lanes: number[], resolved: boolean}} Obstacle
 */
/** @type {Obstacle[]} */
const obstacles = Array.from({ length: OBS_SLOTS }, () => ({ active: false, type: 'block', z: 0, lanes: [], resolved: false }));
let obsNext = 0;

/** @param {number} z */
function spawnObstacle(z) {
  const slot = obsNext;
  obsNext = (obsNext + 1) % OBS_SLOTS;
  const o = obstacles[slot];
  const b = slot * OBS_BOXES;
  for (let k = 0; k < OBS_BOXES; k++) obsBoxes.hide(b + k);
  const roll = Math.random();
  o.active = true;
  o.resolved = false;
  o.z = z;
  o.lanes = [];
  const seed = Math.random() * 100;
  if (roll < 0.5) {
    o.type = 'block';
    const open = Math.floor(Math.random() * 3) - 1;
    const blocked = [-1, 0, 1].filter((l) => l !== open);
    if (Math.random() < 0.45) blocked.splice(Math.floor(Math.random() * 2), 1);
    o.lanes = blocked;
    blocked.forEach((lane, k) => obsBoxes.set(b + k, lane * CFG.laneWidth, 0, z, 2.4, 3.2, 2.4, seed + k));
  } else {
    o.type = roll < 0.75 ? 'low' : 'high';
    const y = o.type === 'low' ? 0 : 0.78;
    const h = o.type === 'low' ? 0.9 : 3.6;
    obsBoxes.set(b, 0, y, z, TRACK_HALF * 2, h, 0.35, seed);
    obsBoxes.set(b + 1, -TRACK_HALF - 0.35, 0, z, 0.5, y + h + 0.3, 0.7, seed + 1);
    obsBoxes.set(b + 2, TRACK_HALF + 0.35, 0, z, 0.5, y + h + 0.3, 0.7, seed + 2);
  }
  dbg('spawn', o.type, 'z', z.toFixed(0), 'lanes', o.lanes.join(','));
}

// ---------------------------------------------------------------- game state

const state = {
  paused: false,
  time: 0,
  dist: 0,            // distance travelled; world z of the dart is -dist
  speed: CFG.speedStart,
  lane: 0,
  x: 0,
  y: CFG.hoverY,
  vy: 0,
  grounded: true,
  fastFall: false,
  duckT: 0,
  duckHeld: false,
  jumpBuf: 0,
  squash: 1,
  roll: 0,
  pitch: 0,
  invuln: 0,
  glitch: 0,
  shake: 0,
  hits: 0,
  corrupted: 0,
  nextSpawn: 140,
  histK: -1,
};

function reset() {
  Object.assign(state, {
    time: state.time, dist: 0, speed: CFG.speedStart, lane: 0, x: 0, y: CFG.hoverY, vy: 0,
    grounded: true, fastFall: false, duckT: 0, duckHeld: false, jumpBuf: 0, squash: 1, roll: 0, pitch: 0,
    invuln: 0, glitch: 0, shake: 0, hits: 0, corrupted: 0, nextSpawn: 140, histK: -1,
  });
  histData.fill(0);
  histTex.needsUpdate = true;
  pLife.fill(0);
  for (const o of obstacles) o.active = false;
  for (let i = 0; i < OBS_SLOTS * OBS_BOXES; i++) obsBoxes.hide(i);
  initTowers();
  dbg('reset');
}

// ---------------------------------------------------------------- input

/** @param {number} dir */
function changeLane(dir) {
  const next = Math.max(-1, Math.min(1, state.lane + dir));
  if (next !== state.lane) {
    state.lane = next;
    dbg('lane', next);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  switch (e.code) {
    case 'ArrowLeft': case 'KeyA': changeLane(-1); break;
    case 'ArrowRight': case 'KeyD': changeLane(1); break;
    case 'ArrowUp': case 'KeyW': case 'Space': state.jumpBuf = CFG.jumpBuffer; break;
    case 'ArrowDown': case 'KeyS':
      state.duckHeld = true;
      if (state.grounded) { state.duckT = CFG.duckTime; dbg('duck'); } else { state.fastFall = true; dbg('fast-fall'); }
      break;
    case 'KeyP': state.paused = !state.paused; dbg('paused', state.paused); break;
    case 'KeyR': reset(); break;
    default: return;
  }
  e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown' || e.code === 'KeyS') state.duckHeld = false;
});

// ---------------------------------------------------------------- simulation

/** @param {number} dt */
function updateDart(dt) {
  state.speed = Math.min(CFG.speedMax, state.speed + CFG.speedAccel * dt);
  state.dist += state.speed * dt;

  const targetX = state.lane * CFG.laneWidth;
  const prevX = state.x;
  state.x += (targetX - state.x) * (1 - Math.exp(-dt * CFG.laneSnap));
  const vx = (state.x - prevX) / dt;

  state.jumpBuf -= dt;
  if (state.jumpBuf > 0 && state.grounded) {
    state.vy = CFG.jumpV;
    state.grounded = false;
    state.fastFall = false;
    state.duckT = 0;
    state.jumpBuf = 0;
    dbg('jump');
  }

  if (state.grounded) {
    if (state.duckHeld) state.duckT = Math.max(state.duckT, 0.08);
    state.duckT = Math.max(0, state.duckT - dt);
    const target = state.duckT > 0 ? CFG.duckY : CFG.hoverY;
    state.y += (target - state.y) * (1 - Math.exp(-dt * 22));
  } else {
    state.vy -= CFG.gravity * (state.fastFall ? CFG.fastFallMul : 1) * dt;
    state.y += state.vy * dt;
    if (state.y <= CFG.hoverY && state.vy < 0) {
      state.y = CFG.hoverY;
      state.vy = 0;
      state.grounded = true;
      if (state.fastFall) state.duckT = CFG.duckTime * 0.6;
      state.fastFall = false;
      dbg('land');
    }
  }

  const squashTarget = state.grounded && state.duckT > 0 ? 0.42 : 1;
  state.squash += (squashTarget - state.squash) * (1 - Math.exp(-dt * 24));
  state.roll += (-vx * 0.045 - state.roll) * (1 - Math.exp(-dt * 14));
  const pitchTarget = state.grounded ? 0 : Math.max(-0.5, Math.min(0.45, state.vy * 0.035));
  state.pitch += (pitchTarget - state.pitch) * (1 - Math.exp(-dt * 12));

  state.invuln = Math.max(0, state.invuln - dt);
  state.glitch = Math.max(0, state.glitch - dt * 2.2);
  state.shake = Math.max(0, state.shake - dt * 3);

  const z = -state.dist;
  const bob = state.grounded ? Math.sin(state.time * 5) * 0.035 : 0;
  dart.group.position.set(state.x, state.y + bob, z);
  dart.group.rotation.set(state.pitch, -vx * 0.012, state.roll, 'YXZ');
  dart.group.scale.set(1 + (1 - state.squash) * 0.3, state.squash, 1);
  dart.group.visible = state.invuln <= 0 || Math.floor(state.time * 22) % 2 === 0;
  dart.shell.material.uniforms.uFlash.value = state.glitch;

  // Record the lateral path so the floor shader can paint the infection where the dart actually went.
  const k = Math.floor(state.dist / CFG.histStep);
  if (k !== state.histK) {
    for (let j = state.histK + 1; j <= k; j++) histData[((j % CFG.histLen) + CFG.histLen) % CFG.histLen] = state.x;
    state.histK = k;
    histTex.needsUpdate = true;
  }

  pDebt += dt * (state.grounded ? 170 : 90);
  while (pDebt > 1) {
    pDebt -= 1;
    const back = 0.75 + Math.random() * 0.2;
    spawnParticle(
      state.x + (Math.random() - 0.5) * 1.5, state.y + (Math.random() - 0.6) * 0.5, z + 0.9,
      (Math.random() - 0.5) * 2.5, (Math.random() - 0.35) * 1.5, -state.speed * back,
      0.35 + Math.random() * 0.5, 0.03 + Math.random() * 0.05,
    );
  }
}

function updateTowers() {
  const z = -state.dist;
  let recycled = 0;
  for (let i = 0; i < TOWER_COUNT; i++) {
    const t = towers[i];
    if (t.z > z + 22) {
      placeTower(i, t.z - TOWER_SPAN);
      recycled++;
      continue;
    }
    if (t.infected) continue;
    // The infection front runs ahead of the dart and loses reach with lateral distance,
    // so hugging one side of the track pushes corruption deeper into that side.
    const ahead = z - t.z;
    const reach = CFG.corruptReach - Math.abs(t.x - state.x);
    if (ahead < reach) {
      t.infected = true;
      towerBoxes.infect(i, state.time);
      towerBoxes.infect(i + TOWER_COUNT, state.time + 0.08);
      state.corrupted++;
    }
  }
  if (recycled > 0 && state.corrupted % 50 === 0) dbg('recycled', recycled, 'corrupted', state.corrupted);
}

/** @param {Obstacle} o @param {number} slot */
function hit(o, slot) {
  state.hits++;
  state.speed = Math.max(CFG.speedStart * 0.7, state.speed * CFG.hitSlow);
  state.invuln = CFG.hitInvuln;
  state.glitch = 1;
  state.shake = 1;
  for (let k = 0; k < OBS_BOXES; k++) obsBoxes.infect(slot * OBS_BOXES + k, state.time);
  const z = -state.dist;
  for (let n = 0; n < 60; n++) {
    spawnParticle(
      state.x + (Math.random() - 0.5) * 2, state.y + Math.random(), z - 1,
      (Math.random() - 0.5) * 14, Math.random() * 7, -state.speed * (0.5 + Math.random() * 0.5),
      0.5 + Math.random() * 0.6, 0.08 + Math.random() * 0.12,
    );
  }
  dbg('HIT', o.type, 'hits', state.hits, 'y', state.y.toFixed(2), 'x', state.x.toFixed(2));
}

function updateObstacles() {
  const z = -state.dist;
  while (state.dist + 200 > state.nextSpawn) {
    spawnObstacle(-state.nextSpawn);
    state.nextSpawn += Math.max(state.speed * 0.95, 30) + Math.random() * 22;
  }
  const halfH = 0.3 * state.squash;
  for (let s = 0; s < OBS_SLOTS; s++) {
    const o = obstacles[s];
    if (!o.active) continue;
    if (o.z > z + 14) {
      o.active = false;
      for (let k = 0; k < OBS_BOXES; k++) obsBoxes.hide(s * OBS_BOXES + k);
      continue;
    }
    if (o.resolved || Math.abs(o.z - z) > 1.5) continue;
    let collide;
    if (o.type === 'block') collide = o.lanes.some((l) => Math.abs(l * CFG.laneWidth - state.x) < 1.55) && state.y - halfH < 3.2;
    else if (o.type === 'low') collide = state.y - halfH < 0.9;
    else collide = state.y + halfH > 0.78;
    if (collide && state.invuln <= 0) {
      o.resolved = true;
      hit(o, s);
    } else if (o.z > z + 1.4) {
      o.resolved = true;
    }
  }
}

// ---------------------------------------------------------------- camera, post, loop

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.55, 0.62);
composer.addPass(bloom);
const lensPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime, uGlitch: { value: 0 }, uSpeed: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGlitch;
    uniform float uSpeed;
    varying vec2 vUv;
    ${GLSL_HASH}
    void main() {
      vec2 uv = vUv;
      if (uGlitch > 0.01) {
        float band = floor(uv.y * 26.0 + uTime * 30.0);
        float h = hash(vec2(band, floor(uTime * 20.0)));
        if (h > 0.6) uv.x += (h - 0.8) * 0.16 * uGlitch;
      }
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      float ca = r2 * (0.012 + 0.018 * uSpeed) + uGlitch * 0.012;
      vec3 col = vec3(
        texture2D(tDiffuse, uv - c * ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv + c * ca).b
      );
      col *= 0.95 + 0.05 * sin(gl_FragCoord.y * 1.57);
      col *= 1.0 - r2 * 0.85;
      col = mix(col, col * vec3(1.5, 0.55, 0.3) + vec3(0.05, 0.0, 0.0), uGlitch * 0.35);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(lensPass);
composer.addPass(new OutputPass());

const camPos = new THREE.Vector3(0, 2.7, 8);
const camLook = new THREE.Vector3();

/** @param {number} dt */
function updateCamera(dt) {
  const z = -state.dist;
  const sp = (state.speed - CFG.speedStart) / (CFG.speedMax - CFG.speedStart);
  const k = 1 - Math.exp(-dt * 7);
  camPos.x += (state.x * 0.62 - camPos.x) * k;
  camPos.y += (2.5 + (state.y - CFG.hoverY) * 0.35 - camPos.y) * k;
  camPos.z = z + 7.6 - sp * 0.8;
  const sh = state.shake * 0.35;
  camera.position.set(camPos.x + (Math.random() - 0.5) * sh, camPos.y + (Math.random() - 0.5) * sh, camPos.z);
  camLook.set(camPos.x * 0.85 + state.x * 0.1, 1.15 + (state.y - CFG.hoverY) * 0.2, z - 14);
  camera.lookAt(camLook);
  camera.rotateZ(state.roll * 0.12);
  const fov = 62 + sp * 16;
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  lensPass.uniforms.uSpeed.value = sp;
  lensPass.uniforms.uGlitch.value = state.glitch;

  const fz = z - FLOOR_SIZE * 0.5 + 40;
  floor.position.z = fz;
  mirror.position.z = fz;
  horizon.position.set(0, 14, z - 420);
  floorMat.uniforms.uDartD.value = state.dist;
  floorMat.uniforms.uDartX.value = state.x;
  floorMat.uniforms.uDartY.value = state.y;
}

const hudEl = document.getElementById('hud');
function updateHud() {
  hudEl.innerHTML =
    `velocity <b>${state.speed.toFixed(0)}</b><br>` +
    `nodes corrupted <b>${state.corrupted}</b><br>` +
    `firewall hits <b>${state.hits}</b>` +
    (state.paused ? '<br><b>paused</b>' : '');
}

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  particles.material.uniforms.uScale.value = h;
  dbg('resize', w, h);
});

let lastMs = 0;
let frames = 0;
let fpsT = 0;

/** @param {number} ms */
function frame(ms) {
  const dt = Math.min((ms - lastMs) / 1000, 0.05);
  lastMs = ms;
  if (!state.paused && dt > 0) {
    state.time += dt;
    uTime.value = state.time;
    updateDart(dt);
    updateTowers();
    updateObstacles();
    updateParticles(dt);
    updateCamera(dt);
  }
  updateHud();
  composer.render();
  frames++;
  fpsT += dt;
  if (fpsT >= 5) {
    dbg('fps', (frames / fpsT).toFixed(0), 'speed', state.speed.toFixed(1), 'dist', state.dist.toFixed(0), 'calls', renderer.info.render.calls);
    frames = 0;
    fpsT = 0;
  }
}

initTowers();
updateCamera(1);
renderer.setAnimationLoop(frame);

// Handle for poking at the game from the console and from automated checks.
Object.assign(window, { __game: { state, CFG, obstacles, towers, reset, renderer, scene, camera, composer, bloom, lensPass, mirror, floor, dart }  });
dbg('ready');
