// @ts-check
// Datacore Runner - grid navigation prototype.
// The dart flies forward on its own through a street grid; the player queues turns.
// No obstacles, pickups or opponents yet: this file exists to get turning right first.
// The original straight-line runner demo is frozen in runner.js / runner.html.

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
  pitch: 36,             // street centre to street centre
  streetHalf: 5,         // half the street width
  turnRadius: 5,         // radius of a turn taken on time
  lateTurnMin: 0.8,      // a turn pressed closer than this to the centre waits for the next intersection
  speed: 30,
  speedMin: 10,
  speedMax: 80,
  hoverY: 0.6,
  camBack: 7.6,
  camHeight: 2.5,
  camYawRate: 5.5,       // how fast the chase camera swings round a corner
  corruptAhead: 6,       // infection probe sits this far in front of the dart
  corruptRadius: 12,     // passive reach: only the towers lining the street
  exploitRadius: 36,     // an exploited vulnerability corrupts everything this close to it
  arena: 9,              // the level is arena x arena blocks, walled in
  wallChance: 0.2,       // chance any one street segment inside the arena is firewalled
  nodeChance: 0.22,      // chance an open street segment carries a vulnerability
  wallStop: 2,           // how far past an intersection centre the dart gets before it meets a firewall
  hitSlow: 0.55,         // fraction of speed lost on hitting a firewall
  hitRecover: 1.2,       // seconds to get it back
  defSpeed: 0.85,        // defender speed while patching, as a fraction of CFG.speed
  defHuntSpeed: 1.06,    // and while hunting: slightly faster than the hacker's default
  defHuntRange: 3.2,     // blocks; closer than this and the defender starts hunting
  defLeashRange: 6,      // blocks; further than this and it gives up
  defHuntTime: 10,       // seconds a hunt lasts at most
  defCooldown: 6,        // seconds it ignores the hacker afterwards
  defTravelWeight: 0.35, // how much blue's own travel counts against racing for a node near the hacker (0 = not at all)
  catchRadius: 2.6,
  catchLoss: 3,          // exploits lost when caught: this many, or half of those held, whichever is more
  deadTime: 1.6,         // seconds between being caught and reappearing
  respawnInvuln: 2.5,    // seconds of safety after reappearing
  respawnClear: 3,       // blocks; never reappear closer to the defender than this
  winShare: 0.6,         // red wins by holding this share of the level's vulnerabilities at once
  lives: 3,              // blue wins by catching red this many times
  resecureRadius: 45,    // blocks whose centre is this close to a re-secured node go back to green
  climbSpeed: 30,
  viewBlocks: 5,         // blocks kept alive in each direction around the dart
  blockSub: 3,           // towers per block side
  trailStep: 0.5,
  trailLen: 220,
  resFpsFloor: 45,      // below this average frame rate the picture is rendered at a lower resolution
  resFpsTarget: 55,      // the frame rate a step down aims for
  resMin: 0.5,           // never below this many rendered pixels per screen pixel
  saverSpeed: 15,        // screensaver: cruising speed
  saverLeash: 60,        // screensaver: blocks from the centre before the camera is steered back
  saverYawRate: 2.4,     // screensaver: slower swing round corners than the chase camera
  saverCorruptAhead: 12, // screensaver: corruption starts this far in front, so it is seen climbing the towers on approach
  saverCorruptKeep: 4000, // screensaver: towers that stay red; older ones heal, so the city never ends up all red
};

// Screensaver mode (?mode=saver): the same city with no game in it. No walls, no vulnerabilities,
// no dart or defender, and an autopilot choosing the turns. The arena is made far bigger than the
// leash so its walled edge is never in view.
const SAVER = params.get('mode') === 'saver';
// Screensaver option (?mode=saver&corrupt=1): towers turn red as the camera passes, as in the game.
const SAVER_CORRUPT = SAVER && params.has('corrupt') && params.get('corrupt') !== '0';
if (SAVER) {
  Object.assign(CFG, { arena: 200, wallChance: 0, nodeChance: 0, speed: CFG.saverSpeed });
  document.body.classList.add('saver');
}

const COL = {
  green: new THREE.Color(0.10, 1.0, 0.45),
  greenHot: new THREE.Color(0.75, 1.0, 0.85),
  // Red team: the dart and everything it corrupts.
  hack: new THREE.Color(1.0, 0.11, 0.06),
  hackHot: new THREE.Color(1.0, 0.6, 0.5),
  // Firewalls.
  wall: new THREE.Color(1.0, 0.36, 0.04),
  wallHot: new THREE.Color(1.0, 0.62, 0.25),
  vuln: new THREE.Color(1.5, 1.6, 1.45),
  vulnBeam: new THREE.Color(0.30, 0.36, 0.30),
  ownedBeam: new THREE.Color(0.6, 0.05, 0.03),
  // Blue team: the defender and everything it has patched.
  blue: new THREE.Color(0.08, 0.42, 1.0),
  blueHot: new THREE.Color(0.6, 0.85, 1.0),
  patchedBeam: new THREE.Color(0.04, 0.2, 0.6),
};

// Compass directions as [x, z] steps: 0 north (-z), 1 east, 2 south, 3 west.
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

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
const camera = new THREE.PerspectiveCamera(66, window.innerWidth / window.innerHeight, 0.1, 900);

const uTime = { value: 0 };

const GLSL_HASH = /* glsl */`
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;

// ---------------------------------------------------------------- holo boxes
// Every glass tower is one instance here. Corruption is a per-instance start time,
// so the infection effect costs nothing on the CPU once triggered.

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
        uCorruptHot: { value: COL.hackHot },
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
            // Shove along both axes: streets run both ways now, so a tear along x alone
            // would be invisible on towers seen end-on.
            vec2 axis = hash(vec2(aSeed, 3.0)) > 0.5 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            if (h > 0.5) w.xz += axis * shove * amt;
            if (h > 0.93) w.xz += axis * shove * 0.12;
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

  /** @param {number} i */
  cleanse(i) {
    this.infect(i, NEVER);
  }
}

// ---------------------------------------------------------------- city blocks
// The city is endless but only a (2N+1)^2 window of blocks around the dart exists at once.
// Each block is generated from a seed of its coordinates, so it is identical every time it
// comes back into view, and the set of infected towers is remembered across that.

const WIN = CFG.viewBlocks * 2 + 1;
const PER_BLOCK = CFG.blockSub * CFG.blockSub;
const TOWER_COUNT = WIN * WIN * PER_BLOCK;
// Instance i is the glass shell, instance i + TOWER_COUNT is its inner core.
const towerBoxes = new HoloBoxes(TOWER_COUNT * 2, { base: COL.green, hot: COL.greenHot, corrupt: COL.hack });
scene.add(towerBoxes.mesh);

/** @type {{x: number, z: number, live: boolean, infected: boolean, key: string, block: string}[]} */
const towers = Array.from({ length: TOWER_COUNT }, () => ({ x: 0, z: 0, live: false, infected: false, key: '', block: '' }));
/** @type {{bx: number, bz: number}[]} */
const slots = Array.from({ length: WIN * WIN }, () => ({ bx: NaN, bz: NaN }));
/** @type {Set<string>} */
const infectedKeys = new Set();
/** @type {Map<string, number>} */
const blockInfection = new Map();

/** @param {number} a */
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} n @param {number} m */
const mod = (n, m) => ((n % m) + m) % m;

/** @param {number} slot @param {number} bx @param {number} bz */
function buildBlock(slot, bx, bz) {
  slots[slot].bx = bx;
  slots[slot].bz = bz;
  const rng = mulberry32((bx * 73856093) ^ (bz * 19349663) ^ level.seed);
  const margin = CFG.streetHalf + 1.5;
  const span = CFG.pitch - margin * 2;
  const cell = span / CFG.blockSub;
  const block = `${bx},${bz}`;
  for (let k = 0; k < PER_BLOCK; k++) {
    const i = slot * PER_BLOCK + k;
    const t = towers[i];
    const cx = k % CFG.blockSub;
    const cz = Math.floor(k / CFG.blockSub);
    const w = 3.6 + rng() * 3.2;
    const d = 3.6 + rng() * 3.2;
    const tall = rng() < 0.12;
    const h = tall ? 34 + rng() * 22 : 6 + rng() * 24;
    const seed = rng() * 100;
    const x = bx * CFG.pitch + margin + cell * (cx + 0.5) + (rng() - 0.5) * (cell - w);
    const z = bz * CFG.pitch + margin + cell * (cz + 0.5) + (rng() - 0.5) * (cell - d);
    // Gaps in the skyline: a solid wall of glass reads as noise, and the gaps show depth.
    const missing = rng() < 0.2;
    t.x = x; t.z = z; t.block = block; t.key = `${block},${k}`;
    t.live = !missing;
    t.infected = false;
    if (missing) {
      towerBoxes.hide(i);
      towerBoxes.hide(i + TOWER_COUNT);
      continue;
    }
    towerBoxes.set(i, x, 0, z, w, h, d, seed);
    towerBoxes.set(i + TOWER_COUNT, x, 0.3, z, w * 0.45, h * 0.8, d * 0.45, seed + 7.3);
    if (infectedKeys.has(t.key)) {
      t.infected = true;
      towerBoxes.infect(i, -100);
      towerBoxes.infect(i + TOWER_COUNT, -100);
    }
  }
}

let lastBlockX = NaN;
let lastBlockZ = NaN;

function updateBlocks() {
  const cbx = Math.floor(state.x / CFG.pitch);
  const cbz = Math.floor(state.z / CFG.pitch);
  if (cbx === lastBlockX && cbz === lastBlockZ) return;
  lastBlockX = cbx;
  lastBlockZ = cbz;
  let built = 0;
  for (let dz = -CFG.viewBlocks; dz <= CFG.viewBlocks; dz++) {
    for (let dx = -CFG.viewBlocks; dx <= CFG.viewBlocks; dx++) {
      const bx = cbx + dx;
      const bz = cbz + dz;
      const slot = mod(bx, WIN) + WIN * mod(bz, WIN);
      if (slots[slot].bx !== bx || slots[slot].bz !== bz) {
        buildBlock(slot, bx, bz);
        built++;
      }
    }
  }
  dbg('block', cbx, cbz, 'built', built);
}

/** @param {number} px @param {number} pz @param {number} radius @param {number} delayPerUnit */
function infectAround(px, pz, radius, delayPerUnit) {
  const r2 = radius * radius;
  for (let i = 0; i < TOWER_COUNT; i++) {
    const t = towers[i];
    if (!t.live || t.infected) continue;
    const dx = t.x - px;
    const dz = t.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    t.infected = true;
    infectedKeys.add(t.key);
    blockInfection.set(t.block, (blockInfection.get(t.block) ?? 0) + 1);
    // Further towers catch it a beat later, so the infection visibly spreads outward.
    const delay = Math.sqrt(d2) * delayPerUnit;
    towerBoxes.infect(i, state.time + delay);
    towerBoxes.infect(i + TOWER_COUNT, state.time + delay + 0.08);
    state.corrupted++;
  }
}

function updateInfection() {
  const ahead = SAVER ? CFG.saverCorruptAhead : CFG.corruptAhead;
  infectAround(state.x + state.hx * ahead, state.z + state.hz * ahead, CFG.corruptRadius, 0.012);
}

// ---------------------------------------------------------------- streets: firewalls and vulnerabilities
// The maze lives on the street segments ("edges") between intersections. Every intersection owns
// two edges, the one going east and the one going south, so each edge has exactly one owner and
// everything about it (blocked? vulnerable?) is a pure function of the owner's coordinates.

// A level is a finite arena of A x A blocks, so (A+1) x (A+1) intersections numbered 0..A.
// It is generated from one seed: same seed, same maze, same vulnerabilities.
const A = CFG.arena;
const GRID = A + 1;
const START = { ix: Math.floor(A / 2), iz: Math.floor(A / 2) + 1, dir: 0 };
const level = {
  seed: 0,
  blocked: [new Uint8Array(GRID * GRID), new Uint8Array(GRID * GRID)],   // [east edges, south edges]
  node: [new Uint8Array(GRID * GRID), new Uint8Array(GRID * GRID)],
  nodeTotal: 0,
};

/** @param {number} ix @param {number} iz */
const inArena = (ix, iz) => ix >= 0 && iz >= 0 && ix <= A && iz <= A;

/** Does edge e of intersection (ix, iz) lie wholly inside the arena? @param {number} ix @param {number} iz @param {number} e */
function edgeInArena(ix, iz, e) {
  return inArena(ix, iz) && (e === 0 ? ix < A : iz < A);
}

/** @param {number} ix @param {number} iz @param {number} e 0 east, 1 south */
function edgeBlocked(ix, iz, e) {
  // Everything outside the arena counts as blocked, which is what walls the level in.
  if (!edgeInArena(ix, iz, e)) return true;
  return level.blocked[e][ix + iz * GRID] === 1;
}

/** @param {number} ix @param {number} iz @param {number} e */
function edgeHasNode(ix, iz, e) {
  return edgeInArena(ix, iz, e) && level.node[e][ix + iz * GRID] === 1;
}

/** @param {number} seed */
function buildLevel(seed) {
  const rng = mulberry32(seed);
  level.seed = seed;
  /** @type {number[][]} every edge inside the arena as [ix, iz, e] */
  const all = [];
  for (let iz = 0; iz <= A; iz++) {
    for (let ix = 0; ix <= A; ix++) {
      for (let e = 0; e < 2; e++) if (edgeInArena(ix, iz, e)) all.push([ix, iz, e]);
    }
  }
  /** @param {number[]} ed */
  const touchesStart = (ed) => (ed[0] === START.ix && ed[1] === START.iz)
    || (ed[2] === 0 && ed[0] === START.ix - 1 && ed[1] === START.iz)
    || (ed[2] === 1 && ed[0] === START.ix && ed[1] === START.iz - 1);
  for (const ed of all) level.blocked[ed[2]][ed[0] + ed[1] * GRID] = !touchesStart(ed) && rng() < CFG.wallChance ? 1 : 0;

  // Random walls can seal part of the arena off. Flood-fill from the start, and while anything
  // is unreachable, knock out one wall on the frontier. Ends with every intersection reachable.
  let opened = 0;
  for (;;) {
    const seen = new Uint8Array(GRID * GRID);
    const stack = [[START.ix, START.iz]];
    seen[START.ix + START.iz * GRID] = 1;
    let count = 1;
    while (stack.length) {
      const [ix, iz] = stack.pop();
      for (let d = 0; d < 4; d++) {
        const bx = ix + DIRS[d][0];
        const bz = iz + DIRS[d][1];
        if (!isOpen(ix, iz, d) || seen[bx + bz * GRID]) continue;
        seen[bx + bz * GRID] = 1;
        count++;
        stack.push([bx, bz]);
      }
    }
    if (count === GRID * GRID) break;
    const frontier = all.filter((ed) => {
      if (!level.blocked[ed[2]][ed[0] + ed[1] * GRID]) return false;
      const a = seen[ed[0] + ed[1] * GRID];
      const b = ed[2] === 0 ? seen[ed[0] + 1 + ed[1] * GRID] : seen[ed[0] + (ed[1] + 1) * GRID];
      return a !== b;
    });
    const pick = frontier[Math.floor(rng() * frontier.length)];
    level.blocked[pick[2]][pick[0] + pick[1] * GRID] = 0;
    opened++;
  }

  level.nodeTotal = 0;
  for (const ed of all) {
    const has = !level.blocked[ed[2]][ed[0] + ed[1] * GRID] && !touchesStart(ed) && rng() < CFG.nodeChance;
    level.node[ed[2]][ed[0] + ed[1] * GRID] = has ? 1 : 0;
    if (has) level.nodeTotal++;
  }
  const walls = all.filter((ed) => level.blocked[ed[2]][ed[0] + ed[1] * GRID]).length;
  dbg('level', seed, 'edges', all.length, 'walls', walls, 'opened for connectivity', opened, 'vulnerabilities', level.nodeTotal);
}

/** Is the street leaving intersection (ix, iz) in compass direction dir open? @param {number} ix @param {number} iz @param {number} dir */
function isOpen(ix, iz, dir) {
  if (dir === 1) return !edgeBlocked(ix, iz, 0);
  if (dir === 3) return !edgeBlocked(ix - 1, iz, 0);
  if (dir === 2) return !edgeBlocked(ix, iz, 1);
  return !edgeBlocked(ix, iz - 1, 1);
}

const EDGE_SLOTS = WIN * WIN * 2;
// Two firewall panels per blocked edge, one at each mouth, so a closed street reads as closed
// from the intersection instead of from halfway down it.
const wallBoxes = new HoloBoxes(EDGE_SLOTS * 2, { base: COL.wall, hot: COL.wallHot, corrupt: COL.hack, cell: 0.8, brightness: 1.7 });
scene.add(wallBoxes.mesh);

/** @type {{ix: number, iz: number, blocked: boolean, wall: boolean, node: boolean, st: number, rooted: boolean, x: number, z: number, key: string}[]} */
const edges = Array.from({ length: EDGE_SLOTS }, () => ({ ix: NaN, iz: NaN, blocked: false, wall: false, node: false, st: 0, rooted: false, x: 0, z: 0, key: '' }));
/** @type {Set<string>} */
const exploitedKeys = new Set();
// Every vulnerability is settled in at most three moves: whoever touches it first, one reply
// from the other side, then the first side's return, which is final.
//
//   red first:   red exploits (leaves a backdoor) -> blue patches -> red returns through the backdoor: ROOTED
//   blue first:  blue patches (leaves a signature) -> red exploits with a new vuln -> blue returns: LOCKED
//
// exploitedKeys (above) holds everything red has right now, whichever chain it is on.
/** @type {Set<string>} final blue: signature-locked for the rest of the round */
const patchedKeys = new Set();
/** @type {Map<string, number>} blue patched one of red's; red can come back through the backdoor. Value = time made. */
const backdoorAt = new Map();
/** @type {Set<string>} final red: red came back through a backdoor */
const rootedKeys = new Set();
/** @type {Set<string>} blue patched an untouched one; red can still exploit it once */
const sigKeys = new Set();
/** @type {Set<string>} red exploited one blue had patched; blue's return locks it. Subset of exploitedKeys. */
const newVulnKeys = new Set();

const ST_OPEN = 0;       // untouched
const ST_RED = 1;        // red's first exploit; blue can patch it
const ST_LOCKED = 2;     // final blue
const ST_BACKDOOR = 3;   // blue patched red's; red can finalise
const ST_ROOTED = 4;     // final red
const ST_SIG = 5;        // blue's first patch; red can exploit it
const ST_NEWVULN = 6;    // red exploited blue's; blue can finalise

/** @param {string} key */
function nodeStatus(key) {
  if (exploitedKeys.has(key)) return rootedKeys.has(key) ? ST_ROOTED : newVulnKeys.has(key) ? ST_NEWVULN : ST_RED;
  if (patchedKeys.has(key)) return ST_LOCKED;
  if (backdoorAt.has(key)) return ST_BACKDOOR;
  if (sigKeys.has(key)) return ST_SIG;
  return ST_OPEN;
}
/** Can red take it by flying through? @param {number} st */
const redCanTake = (st) => st === ST_OPEN || st === ST_BACKDOOR || st === ST_SIG;
/** Can blue act on it by flying through? @param {number} st */
const blueCanTake = (st) => st === ST_OPEN || st === ST_RED || st === ST_NEWVULN;
// Exploits in the order they were taken, so getting caught costs the most recent ones.
/** @type {{key: string, x: number, z: number}[]} */
const exploitOrder = [];

const nodeMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
// The vulnerability marker: a clear octahedron with code running inside it. Front and back faces
// both draw, at different scroll speeds, which is what gives the code depth inside the glass.
const gemGeo = new THREE.OctahedronGeometry(1.45);
{
  const n = gemGeo.getAttribute('position').count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
  gemGeo.setAttribute('aBary', new THREE.BufferAttribute(bary, 3));
}
const gemMat = new THREE.ShaderMaterial({
  uniforms: { uTime },
  vertexShader: /* glsl */`
    attribute vec3 aBary;
    varying vec3 vBary;
    varying vec3 vP;
    varying vec3 vN;
    varying vec3 vV;
    varying vec3 vTint;
    void main() {
      vBary = aBary;
      vP = position;
      vTint = instanceColor;
      mat4 m = modelMatrix * instanceMatrix;
      vec4 w = m * vec4(position, 1.0);
      vN = normalize(mat3(m) * normal);
      vV = normalize(cameraPosition - w.xyz);
      gl_Position = projectionMatrix * viewMatrix * w;
    }
  `,
  fragmentShader: /* glsl */`
    uniform float uTime;
    varying vec3 vBary;
    varying vec3 vP;
    varying vec3 vN;
    varying vec3 vV;
    varying vec3 vTint;
    ${GLSL_HASH}
    float code(vec2 uv, float speed, float seed) {
      vec2 cs = vec2(0.3, 0.19);
      float col = floor(uv.x / cs.x);
      float ch = hash(vec2(col, seed));
      float y = uv.y + uTime * speed * (0.5 + ch);
      float row = floor(y / cs.y);
      vec2 f = vec2(fract(uv.x / cs.x), fract(y / cs.y));
      float on = step(0.42, hash(vec2(col + seed, row)));
      float wide = 0.35 + 0.5 * hash(vec2(row, col + seed));
      float cell = step(0.12, f.x) * step(f.x, 0.12 + wide) * step(0.2, f.y) * step(f.y, 0.8);
      return on * cell * step(0.25, ch) * (0.4 + 0.6 * hash(vec2(row + floor(uTime * 8.0), col)));
    }
    void main() {
      float edge = 1.0 - smoothstep(0.0, 0.045, min(vBary.x, min(vBary.y, vBary.z)));
      float fres = pow(clamp(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 2.0);
      // Lay the code out across the face it is on: horizontal position around the gem, height up it.
      vec2 uv = vec2(atan(vP.z, vP.x) * 0.9, vP.y);
      float c = gl_FrontFacing ? code(uv, 0.9, 3.0) : code(uv * 1.35 + 0.31, -0.55, 11.0) * 0.55;
      // Kept dim on purpose: any brighter and bloom washes the code out into a white blob.
      vec3 col = vTint * (c * 0.75 + edge * 0.38 + fres * 0.08 + 0.012);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const nodeGems = new THREE.InstancedMesh(gemGeo, gemMat, EDGE_SLOTS);
const beamGeo = new THREE.BoxGeometry(0.2, 1, 0.2);
beamGeo.translate(0, 0.5, 0);
// The beam is what lets a vulnerability be spotted from several blocks away, over the rooftops.
const nodeBeams = new THREE.InstancedMesh(beamGeo, nodeMat, EDGE_SLOTS);
// Blue's patch: a closed cube when the node is locked, a tilted flickering one when backdoored.
const nodeCubes = new THREE.InstancedMesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), nodeMat, EDGE_SLOTS);
// The red crack running up a backdoored node's beam.
const nodeCracks = new THREE.InstancedMesh(beamGeo, nodeMat, EDGE_SLOTS);
const nodeMeshes = [nodeGems, nodeBeams, nodeCubes, nodeCracks];
for (const m of nodeMeshes) {
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(m);
}
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpMat = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const COL_LOCK = new THREE.Color(0.1, 0.5, 1.3);
const COL_BACKDOOR_GEM = new THREE.Color(1.6, 0.2, 0.12);
const COL_SIG_GEM = new THREE.Color(0.75, 1.15, 1.7);
const COL_CRACK = new THREE.Color(1.3, 0.1, 0.06);
const COL_CRACK_BLUE = new THREE.Color(0.15, 0.55, 1.5);
const COL_ROOT = new THREE.Color(1.5, 0.12, 0.07);
const COL_ROOT_BEAM = new THREE.Color(1.1, 0.09, 0.05);
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Set a node's colours for its current state. Positions are animated every frame in updateNodes. @param {number} slot */
function restyle(slot) {
  const ed = edges[slot];
  const st = ed.node ? nodeStatus(ed.key) : ST_OPEN;
  ed.st = st;
  const redBeam = st === ST_RED || st === ST_NEWVULN;
  nodeBeams.setColorAt(slot, st === ST_ROOTED ? COL_ROOT_BEAM : redBeam ? COL.ownedBeam : st === ST_OPEN ? COL.vulnBeam : COL.patchedBeam);
  nodeGems.setColorAt(slot, st === ST_BACKDOOR ? COL_BACKDOOR_GEM : st === ST_SIG ? COL_SIG_GEM : COL.vuln);
  nodeCubes.setColorAt(slot, st === ST_ROOTED ? COL_ROOT : COL_LOCK);
  // The crack is always the colour of the side that still gets to come back.
  nodeCracks.setColorAt(slot, st === ST_NEWVULN ? COL_CRACK_BLUE : COL_CRACK);
  for (const m of nodeMeshes) {
    if (!ed.node) m.setMatrixAt(slot, HIDDEN);
    m.instanceColor.needsUpdate = true;
    m.instanceMatrix.needsUpdate = true;
  }
}

/** @param {number} slot @param {number} ix @param {number} iz @param {number} e */
function buildEdge(slot, ix, iz, e) {
  const ed = edges[slot];
  const P = CFG.pitch;
  ed.ix = ix; ed.iz = iz;
  ed.key = `${ix},${iz},${e}`;
  ed.blocked = edgeBlocked(ix, iz, e);
  // Streets wholly outside the arena are closed too, but only the arena's own boundary gets panels.
  ed.wall = ed.blocked && (inArena(ix, iz) || inArena(e === 0 ? ix + 1 : ix, e === 0 ? iz : iz + 1));
  ed.node = edgeHasNode(ix, iz, e);
  ed.x = e === 0 ? (ix + 0.5) * P : ix * P;
  ed.z = e === 0 ? iz * P : (iz + 0.5) * P;
  const mouth = CFG.streetHalf + 0.5;
  const wide = CFG.streetHalf * 2;
  if (!ed.wall) {
    wallBoxes.hide(slot * 2);
    wallBoxes.hide(slot * 2 + 1);
  } else if (e === 0) {
    wallBoxes.set(slot * 2, ix * P + mouth, 0, iz * P, 0.5, 4.5, wide, ix * 7.1 + iz);
    wallBoxes.set(slot * 2 + 1, (ix + 1) * P - mouth, 0, iz * P, 0.5, 4.5, wide, ix * 3.3 + iz + 5);
  } else {
    wallBoxes.set(slot * 2, ix * P, 0, iz * P + mouth, wide, 4.5, 0.5, ix * 7.1 + iz + 9);
    wallBoxes.set(slot * 2 + 1, ix * P, 0, (iz + 1) * P - mouth, wide, 4.5, 0.5, ix * 3.3 + iz + 13);
  }
  restyle(slot);
}

let lastNodeX = NaN;
let lastNodeZ = NaN;

function updateEdges() {
  const cx = Math.round(state.x / CFG.pitch);
  const cz = Math.round(state.z / CFG.pitch);
  if (cx === lastNodeX && cz === lastNodeZ) return;
  lastNodeX = cx;
  lastNodeZ = cz;
  for (let dz = -CFG.viewBlocks; dz <= CFG.viewBlocks; dz++) {
    for (let dx = -CFG.viewBlocks; dx <= CFG.viewBlocks; dx++) {
      const ix = cx + dx;
      const iz = cz + dz;
      const base = (mod(ix, WIN) + WIN * mod(iz, WIN)) * 2;
      if (edges[base].ix !== ix || edges[base].iz !== iz) {
        buildEdge(base, ix, iz, 0);
        buildEdge(base + 1, ix, iz, 1);
      }
    }
  }
}

/** @param {number} slot */
function exploit(slot) {
  const ed = edges[slot];
  const from = ed.st;
  exploitedKeys.add(ed.key);
  if (from === ST_BACKDOOR) {
    // Red's return: final. Not listed as losable, so getting caught cannot take it back.
    backdoorAt.delete(ed.key);
    rootedKeys.add(ed.key);
    notice('rooted');
  } else {
    if (from === ST_SIG) {
      // Red's one reply to a blue patch. It holds until blue comes back.
      sigKeys.delete(ed.key);
      newVulnKeys.add(ed.key);
      notice('new vuln');
    }
    exploitOrder.push({ key: ed.key, x: ed.x, z: ed.z });
  }
  restyle(slot);
  // The payoff: the infection bursts outward from the node and takes the surrounding blocks.
  infectAround(ed.x, ed.z, CFG.exploitRadius, 0.02);
  for (let n = 0; n < 90; n++) {
    const a = Math.random() * Math.PI * 2;
    const v = 6 + Math.random() * 16;
    spawnParticle(ed.x, 1.2, ed.z, Math.cos(a) * v, Math.random() * 9, Math.sin(a) * v, 0.5 + Math.random() * 0.7, 0.07 + Math.random() * 0.1);
  }
  state.flash = 1;
  dbg('EXPLOIT', ed.key, from === ST_BACKDOOR ? '(backdoor -> rooted)' : from === ST_SIG ? '(new vuln on a blue patch)' : '(first)', 'held', exploitedKeys.size, 'towers', state.corrupted);
}

function updateNodes() {
  const t = state.time;
  for (let slot = 0; slot < EDGE_SLOTS; slot++) {
    const ed = edges[slot];
    if (!ed.node) continue;
    if (state.dead <= 0 && redCanTake(ed.st)) {
      const dx = ed.x - state.x;
      const dz = ed.z - state.z;
      if (dx * dx + dz * dz < 2.4 * 2.4) exploit(slot);
    }
    const st = ed.st;
    // The visual rule, the same on both sides:
    //   steady beam = a first claim, flickering beam with a crack = contested, still cube = final.
    // A gem means red can take it by flying through.
    const contested = st === ST_BACKDOOR || st === ST_NEWVULN;
    const flick = contested ? (Math.sin(t * 37 + slot) > 0.55 ? 0.25 : 0.7 + 0.5 * Math.sin(t * 13 + slot * 2)) : 1;

    tmpMat.compose(tmpPos.set(ed.x, 0, ed.z), tmpQuat.identity(), tmpScale.set(flick, 46, flick));
    nodeBeams.setMatrixAt(slot, tmpMat);

    if (redCanTake(st)) {
      const urgent = st === ST_BACKDOOR;
      const pulse = 1 + Math.sin(t * (urgent ? 11 : 6) + slot) * 0.1;
      tmpQuat.setFromAxisAngle(UP, t * 1.1);
      tmpMat.compose(tmpPos.set(ed.x, 2.3 + Math.sin(t * 2.3 + slot) * 0.15, ed.z), tmpQuat, tmpScale.set(pulse, pulse * 1.4, pulse));
      nodeGems.setMatrixAt(slot, tmpMat);
    } else {
      nodeGems.setMatrixAt(slot, HIDDEN);
    }

    if (st === ST_LOCKED || st === ST_ROOTED) {
      tmpMat.compose(tmpPos.set(ed.x, 1.35, ed.z), tmpQuat.identity(), tmpScale.set(1, 1, 1));
      nodeCubes.setMatrixAt(slot, tmpMat);
    } else {
      nodeCubes.setMatrixAt(slot, HIDDEN);
    }

    if (contested) {
      // A jagged line climbing the beam: offset sideways in steps so it reads as a crack.
      const jx = Math.sin(Math.floor(t * 7) * 2.1 + slot) * 0.18;
      const jz = Math.cos(Math.floor(t * 7) * 1.3 + slot) * 0.18;
      tmpMat.compose(tmpPos.set(ed.x + jx, 0, ed.z + jz), tmpQuat.identity(), tmpScale.set(0.55, 14 + 10 * Math.abs(Math.sin(t * 5 + slot)), 0.55));
      nodeCracks.setMatrixAt(slot, tmpMat);
    } else {
      nodeCracks.setMatrixAt(slot, HIDDEN);
    }
  }
  for (const m of nodeMeshes) m.instanceMatrix.needsUpdate = true;
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

const FLOOR_SIZE = 700;
const floorGeo = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
floorGeo.rotateX(-Math.PI / 2);

// Reflector takes its mirror plane from the mesh transform (local +Z), so the plane has to be
// rotated as an object. Handing it pre-rotated geometry makes a vertical mirror.
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
    uPitch: { value: CFG.pitch },
    uHalf: { value: CFG.streetHalf },
    uDart: { value: new THREE.Vector2() },
    uGreen: { value: COL.green },
    uOrange: { value: COL.hack },
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
    uniform float uPitch;
    uniform float uHalf;
    uniform vec2 uDart;
    uniform vec3 uGreen;
    uniform vec3 uOrange;
    varying vec3 vWorld;

    void main() {
      vec2 p = vWorld.xz;
      float dist = length(vWorld - cameraPosition);
      float fade = exp(-dist * 0.011);
      vec2 aa = fwidth(p);

      // q = distance to the nearest street centreline on each axis.
      vec2 q = abs(mod(p + uPitch * 0.5, uPitch) - uPitch * 0.5);
      float onNS = step(q.x, uHalf);
      float onEW = step(q.y, uHalf);
      float street = max(onNS, onEW);
      float crossing = onNS * onEW;

      float trace = texture2D(uCircuit, p / 28.0).r;
      float fine = texture2D(uCircuit, p / 9.0 + 0.37).r * 0.25;
      trace = trace * (0.25 + 0.75 * (1.0 - street)) + fine * (1.0 - street);

      // Kerb lines along every street, broken where another street crosses.
      float ex = abs(q.x - uHalf);
      float ez = abs(q.y - uHalf);
      float openX = step(uHalf, q.y);
      float openZ = step(uHalf, q.x);
      float line = (1.0 - smoothstep(0.05, 0.07 + aa.x, ex)) * openX + (1.0 - smoothstep(0.05, 0.07 + aa.y, ez)) * openZ;
      float lglow = (exp(-ex * 4.0) * openX + exp(-ez * 4.0) * openZ) * 0.22;
      float pulse = pow(clamp(0.5 + 0.5 * sin((p.x + p.y) * 0.22 + uTime * 7.0), 0.0, 1.0), 12.0)
        * (exp(-ex * 6.0) * openX + exp(-ez * 6.0) * openZ);

      // Dashed centre guide on each street, and a square bracket marking each intersection,
      // so the place where a turn happens is readable from a block away.
      float dashX = (1.0 - smoothstep(0.03, 0.05 + aa.x, q.x)) * openX * step(0.5, fract(p.y * 0.2));
      float dashZ = (1.0 - smoothstep(0.03, 0.05 + aa.y, q.y)) * openZ * step(0.5, fract(p.x * 0.2));
      float ringD = abs(max(q.x, q.y) - (uHalf - 0.7));
      float ring = crossing * (1.0 - smoothstep(0.04, 0.07 + max(aa.x, aa.y), ringD));

      vec2 dd = p - uDart;
      float gd2 = dot(dd, dd);
      float aura = exp(-gd2 * 0.006);
      float glow = exp(-gd2 * 0.35) * 0.33;

      vec3 lineCol = mix(uGreen, uOrange, clamp(aura * 1.3, 0.0, 1.0));
      vec3 col = lineCol * (trace * (0.6 + aura * 1.2) + line + lglow + pulse * 0.8 + (dashX + dashZ) * 0.3 + ring * 0.55);
      col += uOrange * glow;
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

// ---------------------------------------------------------------- trail ribbon
// A strip laid on the floor along the path actually flown, so it bends through corners.

const TRAIL_N = CFG.trailLen;
const trailPts = new Float32Array(TRAIL_N * 2);   // ring of [x, z], newest at trailHead
let trailHead = 0;
let trailCount = 0;
let trailDebt = 0;
const trailPos = new Float32Array(TRAIL_N * 2 * 3);
const trailAge = new Float32Array(TRAIL_N * 2);
const trailSide = new Float32Array(TRAIL_N * 2);
const trailIdx = [];
for (let i = 0; i < TRAIL_N; i++) {
  trailSide[i * 2] = -1;
  trailSide[i * 2 + 1] = 1;
  if (i < TRAIL_N - 1) trailIdx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
}
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
trailGeo.setAttribute('aAge', new THREE.BufferAttribute(trailAge, 1).setUsage(THREE.DynamicDrawUsage));
trailGeo.setAttribute('aSide', new THREE.BufferAttribute(trailSide, 1));
trailGeo.setIndex(trailIdx);
const trail = new THREE.Mesh(trailGeo, new THREE.ShaderMaterial({
  // uHeadFade: with no dart to sit on top of it, the front of the trail fades in instead of ending in a hard edge.
  uniforms: { uOrange: { value: COL.hack }, uHot: { value: COL.hackHot }, uHeadFade: { value: SAVER ? 1 : 0 } },
  vertexShader: /* glsl */`
    attribute float aAge;
    attribute float aSide;
    varying float vAge;
    varying float vSide;
    void main() {
      vAge = aAge;
      vSide = aSide;
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uOrange;
    uniform vec3 uHot;
    uniform float uHeadFade;
    varying float vAge;
    varying float vSide;
    void main() {
      float life = pow(clamp(1.0 - vAge, 0.0, 1.0), 1.6);
      life *= mix(1.0, smoothstep(0.0, 0.05, vAge), uHeadFade);
      float core = exp(-vSide * vSide * 14.0);
      float body = exp(-vSide * vSide * 3.0);
      gl_FragColor = vec4((uOrange * body * 0.55 + uHot * core * 0.25 * life) * life, 1.0);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -3,
  polygonOffsetUnits: -3,
}));
trail.frustumCulled = false;
scene.add(trail);

function resetTrail() {
  trailHead = 0;
  trailCount = 0;
  trailDebt = 0;
  trailGeo.setDrawRange(0, 0);
}

/** @param {number} moved */
function updateTrail(moved) {
  trailDebt += moved;
  while (trailDebt >= CFG.trailStep) {
    trailDebt -= CFG.trailStep;
    trailHead = (trailHead + 1) % TRAIL_N;
    trailPts[trailHead * 2] = state.x;
    trailPts[trailHead * 2 + 1] = state.z;
    trailCount = Math.min(TRAIL_N, trailCount + 1);
  }
  if (trailCount < 2) return;
  const halfW = 1.5;
  for (let j = 0; j < trailCount; j++) {
    const a = mod(trailHead - j, TRAIL_N);
    const b = mod(trailHead - Math.min(j + 1, trailCount - 1), TRAIL_N);
    const c = mod(trailHead - Math.max(j - 1, 0), TRAIL_N);
    // Direction from the older neighbour to the newer one gives the strip its sideways axis.
    let tx = trailPts[c * 2] - trailPts[b * 2];
    let tz = trailPts[c * 2 + 1] - trailPts[b * 2 + 1];
    const len = Math.hypot(tx, tz) || 1;
    tx /= len; tz /= len;
    const x = trailPts[a * 2];
    const z = trailPts[a * 2 + 1];
    const o = j * 6;
    trailPos[o] = x - tz * halfW; trailPos[o + 1] = 0.03; trailPos[o + 2] = z + tx * halfW;
    trailPos[o + 3] = x + tz * halfW; trailPos[o + 4] = 0.03; trailPos[o + 5] = z - tx * halfW;
    trailAge[j * 2] = trailAge[j * 2 + 1] = j / TRAIL_N;
  }
  trailGeo.getAttribute('position').needsUpdate = true;
  trailGeo.getAttribute('aAge').needsUpdate = true;
  trailGeo.setDrawRange(0, (trailCount - 1) * 6);
}

// Floor traces and the trail lie on the mirror itself; reflecting them would double them up.
const mirrorRender = mirror.onBeforeRender;
mirror.onBeforeRender = function (/** @type {Parameters<typeof mirrorRender>} */ ...args) {
  floor.visible = false;
  trail.visible = false;
  mirrorRender.apply(this, args);
  floor.visible = true;
  trail.visible = !SAVER || SAVER_CORRUPT;
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

// Distant haze where the streets vanish. It is a band all the way round the horizon, centred on
// the viewer, so it looks the same whichever way the camera faces. (It used to be one round glow
// held in front of the camera, which showed up as a disc sliding across the towers in every turn.)
function makeHazeTexture() {
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(cv);
}
const HAZE_HEIGHT = 70;
const horizon = new THREE.Mesh(
  new THREE.CylinderGeometry(420, 420, HAZE_HEIGHT, 64, 1, true),
  new THREE.MeshBasicMaterial({
    map: makeHazeTexture(), color: new THREE.Color(0.1, 0.9, 0.4), blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.16, side: THREE.BackSide,
  }),
);
scene.add(horizon);

// ---------------------------------------------------------------- the payload dart

/**
 * @param {{base: THREE.Color, hot: THREE.Color, body: THREE.Color, core: THREE.Color, edge: THREE.Color, halo: THREE.Color}} pal
 */
function makeDart(pal) {
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
    uniforms: { uTime, uOrange: { value: pal.base }, uHot: { value: pal.hot } },
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
    new THREE.LineBasicMaterial({ color: pal.edge, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );

  // Opaque dark body so the glass reads as a solid object instead of washing out over the scenery.
  const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: pal.body }));
  body.scale.setScalar(1.17);
  const core = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: pal.core }));
  core.scale.set(0.34, 0.5, 0.6);
  core.position.set(0, 0.04, 0.05);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: pal.halo, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, opacity: 0.22,
  }));
  halo.scale.set(5, 3.2, 1);

  const group = new THREE.Group();
  group.add(body, shell, edges, core, halo);
  shell.scale.setScalar(1.2);
  edges.scale.setScalar(1.2);
  return { group, shell };
}

const dart = makeDart({
  base: COL.hack, hot: COL.hackHot, body: new THREE.Color(0.42, 0.03, 0.02), core: new THREE.Color(0.95, 0.12, 0.06),
  edge: new THREE.Color(1.35, 0.55, 0.45), halo: new THREE.Color(1.0, 0.12, 0.08),
});
scene.add(dart.group);

const defDart = makeDart({
  base: COL.blue, hot: COL.blueHot, body: new THREE.Color(0.02, 0.08, 0.42), core: new THREE.Color(0.08, 0.35, 0.95),
  edge: new THREE.Color(0.5, 0.85, 1.45), halo: new THREE.Color(0.1, 0.4, 1.0),
});
// A beacon above the defender so it can be seen coming over the rooftops.
const defBeacon = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.45, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
defBeacon.scale.set(1.4, 60, 1.4);
defBeacon.position.y = 1;
defDart.group.add(defBeacon);
scene.add(defDart.group);

// ---------------------------------------------------------------- trail fragments

const P_COUNT = 1000;
const pPos = new Float32Array(P_COUNT * 3);
const pVel = new Float32Array(P_COUNT * 3);
const pLife = new Float32Array(P_COUNT);      // remaining, seconds
const pFade = new Float32Array(P_COUNT);      // 0..1 for the shader
const pSize = new Float32Array(P_COUNT);
const pShape = new Float32Array(P_COUNT);     // 0 thin dash, 1 square pixel
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aFade', new THREE.BufferAttribute(pFade, 1).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
pGeo.setAttribute('aShape', new THREE.BufferAttribute(pShape, 1));
const particles = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: { uOrange: { value: COL.hack }, uHot: { value: COL.hackHot }, uScale: { value: window.innerHeight } },
  vertexShader: /* glsl */`
    attribute float aFade;
    attribute float aSize;
    attribute float aShape;
    uniform float uScale;
    varying float vFade;
    varying float vShape;
    void main() {
      vFade = aFade;
      vShape = aShape;
      vec4 mv = viewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform vec3 uOrange;
    uniform vec3 uHot;
    varying float vFade;
    varying float vShape;
    void main() {
      // A tall thin dash, not a dot: reads as a fragment of data shearing off.
      // The death burst uses full squares instead, so it reads as pixels.
      vec2 c = abs(gl_PointCoord - 0.5);
      if (c.x > mix(0.16, 0.46, vShape) || c.y > 0.46 || vFade <= 0.0) discard;
      gl_FragColor = vec4(mix(uOrange, uHot, vFade * vFade * 0.5) * vFade * 0.7, 1.0);
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}));
particles.frustumCulled = false;
scene.add(particles);
if (SAVER) {
  dart.group.visible = false;
  defDart.group.visible = false;
  trail.visible = SAVER_CORRUPT;
  particles.visible = false;
}
let pNext = 0;
let pDebt = 0;

/** @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz @param {number} life @param {number} size @param {number} [shape] */
function spawnParticle(x, y, z, vx, vy, vz, life, size, shape = 0) {
  const i = pNext;
  pNext = (pNext + 1) % P_COUNT;
  pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
  pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
  pLife[i] = life;
  pSize[i] = size;
  pShape[i] = shape;
  pGeo.getAttribute('aSize').needsUpdate = true;
  pGeo.getAttribute('aShape').needsUpdate = true;
}

/** @param {number} dt */
function updateParticles(dt) {
  pDebt += state.dead > 0 ? 0 : dt * 170;
  while (pDebt > 1) {
    pDebt -= 1;
    const back = 0.75 + Math.random() * 0.2;
    const side = (Math.random() - 0.5) * 1.5;
    // Spawned at the tail and thrown forward a little slower than the dart, so they fall behind.
    spawnParticle(
      state.x - state.hx * 0.9 - state.hz * side, state.y + (Math.random() - 0.6) * 0.5, state.z - state.hz * 0.9 + state.hx * side,
      state.hx * state.speed * back + (Math.random() - 0.5) * 2.5, (Math.random() - 0.35) * 1.5, state.hz * state.speed * back + (Math.random() - 0.5) * 2.5,
      0.35 + Math.random() * 0.5, 0.03 + Math.random() * 0.05,
    );
  }
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

// ---------------------------------------------------------------- navigation state

const state = {
  paused: false,
  time: 0,
  speed: CFG.speed,
  x: START.ix * CFG.pitch,
  y: CFG.hoverY,
  z: START.iz * CFG.pitch,
  dir: START.dir,        // index into DIRS: the street direction being flown
  nextX: START.ix,       // grid coords of the intersection ahead
  nextZ: START.iz - 1,
  queued: 0,             // turn waiting for the next intersection: -1 left, 0 none, 1 right
  // Heading. yaw is the true heading, continuous (never wrapped) so the camera can chase it.
  yaw: 0,
  hx: 0,
  hz: -1,
  yawVis: 0,             // what the dart model shows; eases after yaw
  camYaw: 0,
  roll: 0,
  camRoll: 0,            // camera bank; follows turns but not the queued-turn lean
  // Active turn, or null on a straight.
  /** @type {null | {ax: number, az: number, d0: number, d1: number, r: number, phi: number, sign: number, yaw0: number, blocked: boolean, rev: boolean}} */
  arc: null,
  turns: 0,
  corrupted: 0,
  hits: 0,
  caught: 0,
  dist: 0,
  glitch: 0,             // screen tear after hitting a firewall, 1 fading to 0
  slow: 0,               // speed penalty after a hit, 1 fading to 0
  flash: 0,              // brief bloom kick when a vulnerability is exploited
  notice: '',            // short message shown in place of the next-turn readout
  noticeT: 0,
  over: '',              // '' while playing, then 'red' or 'blue'
  dead: 0,               // seconds left before reappearing after being caught
  invuln: 0,             // seconds of safety left after reappearing
};

/** @param {number} [seed] omit for a fresh random level */
function reset(seed) {
  buildLevel(seed ?? Math.floor(Math.random() * 1e9));
  Object.assign(state, {
    speed: CFG.speed, x: START.ix * CFG.pitch, y: CFG.hoverY, z: START.iz * CFG.pitch, dir: START.dir,
    nextX: START.ix, nextZ: START.iz - 1, queued: 0,
    yaw: 0, hx: 0, hz: -1, yawVis: 0, camYaw: 0, roll: 0, camRoll: 0, arc: null, turns: 0, corrupted: 0, dist: 0,
    hits: 0, caught: 0, glitch: 0, slow: 0, flash: 0, notice: '', noticeT: 0, dead: 0, invuln: 0, over: '',
  });
  document.getElementById('banner').style.display = 'none';
  dart.group.visible = true;
  backdoorAt.clear();
  rootedKeys.clear();
  sigKeys.clear();
  newVulnKeys.clear();
  exploitedKeys.clear();
  patchedKeys.clear();
  exploitOrder.length = 0;
  // Opposite corner from the start, so the first contact takes a little while.
  spawnDefender(A, 0);
  for (const ed of edges) { ed.ix = NaN; ed.iz = NaN; ed.node = false; }
  lastNodeX = NaN;
  lastNodeZ = NaN;
  infectedKeys.clear();
  blockInfection.clear();
  pLife.fill(0);
  resetTrail();
  for (const sl of slots) { sl.bx = NaN; sl.bz = NaN; }
  lastBlockX = NaN;
  lastBlockZ = NaN;
  updateBlocks();
  updateEdges();
  dbg('reset, level', level.seed);
}

/** @param {number} turn -1 left, 0 straight, 1 right */
function queueTurn(turn) {
  state.queued = turn;
  dbg('queue', turn === 0 ? 'straight' : turn < 0 ? 'left' : 'right', 'rem', distToNext().toFixed(1));
}

/** Distance along the current street to the centre of the intersection ahead. */
function distToNext() {
  const d = DIRS[state.dir];
  return (state.nextX * CFG.pitch - state.x) * d[0] + (state.nextZ * CFG.pitch - state.z) * d[1];
}

/** @param {string} text */
function notice(text) {
  state.notice = text;
  state.noticeT = 0.9;
}

function reverse() {
  if (state.arc) { dbg('reverse ignored mid-turn'); return; }
  const d = DIRS[state.dir];
  // Normally the intersection ahead after a flip is the one just behind. The exception is the
  // run-up to a firewall, past the centre of an intersection: that same intersection is still it.
  if (distToNext() >= 0) {
    state.nextX -= d[0];
    state.nextZ -= d[1];
  }
  state.dir = (state.dir + 2) % 4;
  state.yaw += Math.PI;
  state.queued = 0;
  state.turns++;
  dbg('reverse, now dir', state.dir);
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyF') { setStats(!statsOn); e.preventDefault(); return; }
  if (SAVER) return;
  switch (e.code) {
    case 'ArrowLeft': case 'KeyA': queueTurn(-1); break;
    case 'ArrowRight': case 'KeyD': queueTurn(1); break;
    case 'ArrowUp': case 'KeyW': queueTurn(0); break;
    case 'ArrowDown': case 'KeyS': reverse(); break;
    case 'BracketLeft': state.speed = Math.max(CFG.speedMin, state.speed - 2); dbg('speed', state.speed); break;
    case 'BracketRight': state.speed = Math.min(CFG.speedMax, state.speed + 2); dbg('speed', state.speed); break;
    case 'KeyP': state.paused = !state.paused; dbg('paused', state.paused); break;
    case 'KeyR': reset(); break;   // new random level
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------- screensaver autopilot

let saverPlanFor = '';

// Picks the turn for each intersection as it comes up: mostly straight, sometimes left or right,
// never into a closed street, and back towards the centre once the leash runs out.
function saverSteer() {
  if (state.arc) return;
  const key = `${state.nextX},${state.nextZ}`;
  if (key === saverPlanFor) return;
  saverPlanFor = key;
  const mid = Math.floor(A / 2);
  const far = (/** @type {number} */ ix, /** @type {number} */ iz) => Math.max(Math.abs(ix - mid), Math.abs(iz - mid));
  const here = far(state.nextX, state.nextZ);
  /** @type {number[]} */
  let options = [];
  for (const turn of [-1, 0, 0, 1]) {   // straight listed twice: half of all choices
    const dir = mod(state.dir + turn, 4);
    if (isOpen(state.nextX, state.nextZ, dir)) options.push(turn);
  }
  if (here > CFG.saverLeash) {
    const inward = options.filter((turn) => {
      const d = DIRS[mod(state.dir + turn, 4)];
      return far(state.nextX + d[0], state.nextZ + d[1]) < here;
    });
    if (inward.length) options = inward;
  }
  if (!options.length) {
    reverse();
    saverPlanFor = '';
    return;
  }
  state.queued = options[Math.floor(Math.random() * options.length)];
}

// The oldest corruption is forgotten once the limit is passed. Those towers are far behind and
// out of sight, so they are simply green again the next time the camera comes by. Without this
// a screensaver left running would slowly turn the whole city red and never stop using more memory.
function saverHeal() {
  for (const tk of infectedKeys) {   // a Set walks in the order things were added: oldest first
    if (infectedKeys.size <= CFG.saverCorruptKeep) break;
    infectedKeys.delete(tk);
    state.corrupted--;
    const [bx, bz] = tk.split(',');
    const block = `${bx},${bz}`;
    const left = (blockInfection.get(block) ?? 0) - 1;
    if (left > 0) blockInfection.set(block, left);
    else blockInfection.delete(block);
  }
}

// ---------------------------------------------------------------- simulation

function hitFirewall() {
  state.hits++;
  state.glitch = 1;
  state.slow = 1;
  for (let n = 0; n < 50; n++) {
    spawnParticle(
      state.x + state.hx * 2, state.y + Math.random(), state.z + state.hz * 2,
      -state.hx * (4 + Math.random() * 14) + (Math.random() - 0.5) * 12, Math.random() * 7, -state.hz * (4 + Math.random() * 14) + (Math.random() - 0.5) * 12,
      0.4 + Math.random() * 0.6, 0.06 + Math.random() * 0.1,
    );
  }
  dbg('FIREWALL HIT', 'hits', state.hits, 'at', state.x.toFixed(1), state.z.toFixed(1));
  notice('firewall');
}

/** @param {number} dt */
function updateDart(dt) {
  state.glitch = Math.max(0, state.glitch - dt * 2.2);
  state.slow = Math.max(0, state.slow - dt / CFG.hitRecover);
  state.flash = Math.max(0, state.flash - dt * 2.5);
  state.noticeT = Math.max(0, state.noticeT - dt);
  state.invuln = Math.max(0, state.invuln - dt);
  if (state.dead > 0) {
    // Caught: nothing to fly. Hold the screen tear until the dart reappears somewhere else.
    state.glitch = Math.max(state.glitch, 0.4);
    state.dead -= dt;
    if (state.dead <= 0) respawnHacker();
    return;
  }
  let move = state.speed * (1 - CFG.hitSlow * state.slow) * dt;
  state.dist += move;
  updateTrail(move);

  // A frame can end a straight and begin a turn (or the reverse), so spend the distance in pieces.
  for (let guard = 0; guard < 4 && move > 1e-6; guard++) {
    if (state.arc) {
      const a = state.arc;
      // a.rev: the turn ran into a firewall and is being flown backwards, out the way it came in.
      const left = (a.rev ? a.phi : Math.PI / 2 - a.phi) * a.r;
      const step = Math.min(move, left);
      a.phi += (a.rev ? -step : step) / a.r;
      move -= step;
      const d0 = DIRS[a.d0];
      const d1 = DIRS[a.d1];
      const s = Math.sin(a.phi);
      const c = Math.cos(a.phi);
      // Quarter circle: centre sits one radius to the turn side of the entry point.
      state.x = a.ax + d1[0] * a.r * (1 - c) + d0[0] * a.r * s;
      state.z = a.az + d1[1] * a.r * (1 - c) + d0[1] * a.r * s;
      state.yaw = a.yaw0 - a.sign * a.phi + (a.rev ? Math.PI : 0);
      if (a.rev) {
        if (a.phi <= 1e-6) {
          // Back at the point the turn began, now flying away from the intersection.
          state.yaw = a.yaw0 + Math.PI;
          state.dir = mod(a.d0 + 2, 4);
          state.nextX -= d0[0];
          state.nextZ -= d0[1];
          state.arc = null;
          dbg('bounced back out, dir', state.dir);
        }
        continue;
      }
      // Turning into a firewalled street is allowed, and it hurts: the dart meets the panel
      // partway round the turn. (A very tight late turn never gets that far sideways, so it hits at the end.)
      if (a.blocked && a.r * (1 - c) >= Math.min(CFG.wallStop, a.r) - 1e-3) {
        hitFirewall();
        a.rev = true;
        continue;
      }
      if (a.phi >= Math.PI / 2 - 1e-6) {
        state.yaw = a.yaw0 - a.sign * Math.PI / 2;
        state.dir = a.d1;
        // The turn ends on the new street's centreline, one radius past the intersection centre.
        state.nextX += d1[0];
        state.nextZ += d1[1];
        state.arc = null;
        state.turns++;
        dbg('turn done, dir', state.dir, 'at', state.x.toFixed(1), state.z.toFixed(1));
      }
      continue;
    }

    const d = DIRS[state.dir];
    const rem = distToNext();
    const openS = isOpen(state.nextX, state.nextZ, state.dir);
    const openL = isOpen(state.nextX, state.nextZ, mod(state.dir - 1, 4));
    const openR = isOpen(state.nextX, state.nextZ, mod(state.dir + 1, 4));
    const inWindow = rem <= CFG.turnRadius && rem >= CFG.lateTurnMin;

    // The dart does exactly what was asked. A queued turn is flown whether or not that street
    // is open, and with nothing queued it holds straight, wall or no wall. No auto-steering.
    if (inWindow && state.queued !== 0) {
      const turn = state.queued;
      const blocked = !(turn < 0 ? openL : openR);
      // On time this is a full-radius arc. Pressed late, the arc tightens to whatever room is
      // left before the centre, so a late press still makes the corner.
      state.arc = { ax: state.x, az: state.z, d0: state.dir, d1: mod(state.dir + turn, 4), r: rem, phi: 0, sign: turn, yaw0: state.yaw, blocked, rev: false };
      state.queued = 0;
      dbg('turn start', turn < 0 ? 'left' : 'right', 'radius', rem.toFixed(2), blocked ? '(into a firewall)' : '');
      continue;
    }

    // Run to whichever comes first: the point a turn could start, the centre of an open
    // intersection, or the face of the firewall when the street ahead is closed.
    const untilArc = (state.queued !== 0 || !openS) && rem > CFG.turnRadius ? rem - CFG.turnRadius : Infinity;
    const limit = openS ? Math.max(rem, 0) + 1e-4 : rem + CFG.wallStop;
    const step = Math.max(0, Math.min(move, untilArc, limit));
    state.x += d[0] * step;
    state.z += d[1] * step;
    move -= step;
    const after = distToNext();
    if (openS) {
      if (after <= 0) {
        state.nextX += d[0];
        state.nextZ += d[1];
      }
    } else if (after <= -CFG.wallStop + 1e-3) {
      // Flew straight into a firewall.
      hitFirewall();
      reverse();
      break;
    }
  }

  state.hx = -Math.sin(state.yaw);
  state.hz = -Math.cos(state.yaw);

  const prevVis = state.yawVis;
  state.yawVis += (state.yaw - state.yawVis) * (1 - Math.exp(-dt * 20));
  const yawRate = (state.yawVis - prevVis) / dt;
  // Bank into turns, and lean slightly as soon as a turn is queued so the choice is visible.
  const bank = Math.max(-0.75, Math.min(0.75, yawRate * 0.11));
  const rollTarget = bank - state.queued * 0.2;
  state.roll += (rollTarget - state.roll) * (1 - Math.exp(-dt * 12));
  // The camera banks with the turn itself only. The lean on a queued turn belongs to the dart:
  // on the camera it tilted the whole horizon for as long as the turn stayed queued.
  state.camRoll += (bank - state.camRoll) * (1 - Math.exp(-dt * 12));

  const bob = Math.sin(state.time * 5) * 0.035;
  dart.group.position.set(state.x, state.y + bob, state.z);
  dart.group.rotation.set(0, state.yawVis, state.roll, 'YXZ');
  dart.group.visible = state.invuln <= 0 || Math.floor(state.time * 14) % 2 === 0;
}

// ---------------------------------------------------------------- blue team defender
// Flies the same streets under the same rules as the hacker, but never hits a firewall:
// it plans a route at every intersection. It patches vulnerabilities, re-secures exploited
// ones, and hunts the hacker when the hacker comes close.

const def = {
  x: 0, z: 0, dir: 0, nextX: 0, nextZ: 0,
  yaw: 0, yawVis: 0, roll: 0,
  /** @type {null | {ax: number, az: number, d0: number, d1: number, r: number, phi: number, sign: number, yaw0: number}} */
  arc: null,
  plan: 0,               // for the intersection ahead: -1 left, 0 straight, 1 right, 2 reverse
  planFor: '',
  lastRem: 0,
  mode: 'patch',         // 'patch' or 'hunt'
  huntT: 0,
  cooldown: 0,
  patched: 0,
};

/** @param {number} ix @param {number} iz */
function spawnDefender(ix, iz) {
  let dir = 0;
  for (let d = 0; d < 4; d++) if (isOpen(ix, iz, d)) { dir = d; break; }
  Object.assign(def, {
    x: ix * CFG.pitch, z: iz * CFG.pitch, dir, nextX: ix + DIRS[dir][0], nextZ: iz + DIRS[dir][1],
    yaw: -dir * Math.PI / 2, yawVis: -dir * Math.PI / 2, roll: 0, arc: null, plan: 0, planFor: '', lastRem: CFG.pitch,
    mode: 'patch', huntT: 0, cooldown: CFG.defCooldown,
  });
  dbg('defender spawned at', ix, iz, 'dir', dir);
}

/** The edge leaving intersection (ix, iz) in direction dir, as its owner's [ix, iz, e]. @param {number} ix @param {number} iz @param {number} dir */
function edgeOwner(ix, iz, dir) {
  if (dir === 1) return [ix, iz, 0];
  if (dir === 3) return [ix - 1, iz, 0];
  if (dir === 2) return [ix, iz, 1];
  return [ix, iz - 1, 1];
}

/**
 * What the defender would do on this street segment: 2 take back something red holds,
 * 1 patch an untouched vulnerability, 0 nothing (settled, or red's move next).
 * @param {number} ix @param {number} iz @param {number} dir
 */
function edgeWork(ix, iz, dir) {
  const [ox, oz, e] = edgeOwner(ix, iz, dir);
  if (!edgeHasNode(ox, oz, e)) return 0;
  const st = nodeStatus(`${ox},${oz},${e}`);
  if (st === ST_RED || st === ST_NEWVULN) return 2;
  return st === ST_OPEN ? 1 : 0;
}

/**
 * Breadth-first search over intersections from the one ahead of the defender. Returns the compass
 * direction of the first step of the shortest route to a goal, or -1 if nothing is in range.
 */
function defenderRoute() {
  const hunting = def.mode === 'hunt';
  const pd = DIRS[state.dir];
  // The hacker is on the segment between these two intersections.
  const hackA = `${state.nextX},${state.nextZ}`;
  const hackB = `${state.nextX - pd[0]},${state.nextZ - pd[1]}`;
  const back = mod(def.dir + 2, 4);
  // While patching, an exploited vulnerability anywhere in range outranks a nearer untouched
  // one: the defender responds to intrusions first, and that is what pulls it toward the hacker.
  // Untouched ones it flies over on the way get patched regardless.
  let nearestPatch = -1;
  let bestScore = Infinity;
  /** @type {number[][]} */
  const queue = [];
  const seen = new Set([`${def.nextX},${def.nextZ}`]);
  // Reverse is tried last, so it is only chosen when nothing else is as short.
  for (const d of [def.dir, mod(def.dir + 1, 4), mod(def.dir + 3, 4), back]) queue.push([def.nextX, def.nextZ, d, d, 0]);
  for (let head = 0; head < queue.length; head++) {
    const [ix, iz, d, first, depth] = queue[head];
    if (!isOpen(ix, iz, d)) continue;
    const bx = ix + DIRS[d][0];
    const bz = iz + DIRS[d][1];
    const bk = `${bx},${bz}`;
    if (hunting) {
      if (bk === hackA || bk === hackB) return first;
    } else {
      const work = edgeWork(ix, iz, d);
      if (work === 2) return first;
      if (work === 1) {
        // First touch decides who ends up owning a vulnerability, so blue races the hacker for
        // the untouched ones nearest the hacker, not the ones nearest itself. Its own travel
        // distance still counts a little, so it does not cross the whole arena for one.
        const mx = (ix + DIRS[d][0] * 0.5) * CFG.pitch;
        const mz = (iz + DIRS[d][1] * 0.5) * CFG.pitch;
        // Doubling back costs extra: the target moves as the hacker does, and without this blue
        // flip-flops between two candidates instead of committing to one.
        const score = Math.abs(mx - state.x) + Math.abs(mz - state.z) + depth * CFG.pitch * CFG.defTravelWeight
          + (first === back ? CFG.pitch * 2 : 0);
        if (score < bestScore) { bestScore = score; nearestPatch = first; }
      }
    }
    if (seen.has(bk) || depth >= 20) continue;
    seen.add(bk);
    for (let nd = 0; nd < 4; nd++) if (nd !== mod(d + 2, 4)) queue.push([bx, bz, nd, first, depth + 1]);
  }
  // Nothing exploited in range. Patch locally only while the hacker is nearby; otherwise
  // return -1 so the caller closes the distance instead of wandering off across an endless city.
  const far = Math.abs(def.x - state.x) + Math.abs(def.z - state.z) > CFG.defLeashRange * CFG.pitch;
  return far ? -1 : nearestPatch;
}

function defenderPlan() {
  let target = defenderRoute();
  if (target < 0) {
    // No route found: take whichever open street gets closest to the hacker.
    const open = [def.dir, mod(def.dir + 1, 4), mod(def.dir + 3, 4)].filter((d) => isOpen(def.nextX, def.nextZ, d));
    const gapAfter = (/** @type {number} */ d) => Math.abs((def.nextX + DIRS[d][0]) * CFG.pitch - state.x) + Math.abs((def.nextZ + DIRS[d][1]) * CFG.pitch - state.z);
    open.sort((a, b) => gapAfter(a) - gapAfter(b));
    target = open.length ? open[0] : mod(def.dir + 2, 4);
  }
  const rel = mod(target - def.dir, 4);
  def.plan = rel === 0 ? 0 : rel === 1 ? 1 : rel === 3 ? -1 : 2;
  def.planFor = `${def.nextX},${def.nextZ}`;
}

function defDistToNext() {
  const d = DIRS[def.dir];
  return (def.nextX * CFG.pitch - def.x) * d[0] + (def.nextZ * CFG.pitch - def.z) * d[1];
}

/** Redraw one vulnerability if it is inside the visible window. @param {number} ox @param {number} oz @param {number} e */
function refreshEdge(ox, oz, e) {
  const slot = (mod(ox, WIN) + WIN * mod(oz, WIN)) * 2 + e;
  if (edges[slot].key === `${ox},${oz},${e}`) restyle(slot);
}

/** Take an exploited vulnerability back: patch it and return the surrounding blocks to green. @param {string} key @param {number} x @param {number} z */
function resecure(key, x, z) {
  exploitedKeys.delete(key);
  if (newVulnKeys.delete(key)) {
    // Blue's return on its own patch: the signature catches the new vuln. Final.
    patchedKeys.add(key);
  } else {
    // Blue's one reply to a red exploit. Red keeps a backdoor.
    backdoorAt.set(key, state.time);
  }
  const at = exploitOrder.findIndex((q) => q.key === key);
  if (at >= 0) exploitOrder.splice(at, 1);
  const r2 = CFG.resecureRadius * CFG.resecureRadius;
  /** @type {Set<string>} */
  const cleared = new Set();
  for (const tk of infectedKeys) {
    const [bx, bz] = tk.split(',').map(Number);
    const dx = (bx + 0.5) * CFG.pitch - x;
    const dz = (bz + 0.5) * CFG.pitch - z;
    if (dx * dx + dz * dz > r2) continue;
    infectedKeys.delete(tk);
    cleared.add(`${bx},${bz}`);
    state.corrupted--;
  }
  for (const b of cleared) blockInfection.delete(b);
  for (let i = 0; i < TOWER_COUNT; i++) {
    const t = towers[i];
    if (!t.infected || !cleared.has(t.block)) continue;
    t.infected = false;
    towerBoxes.cleanse(i);
    towerBoxes.cleanse(i + TOWER_COUNT);
  }
  const [ox, oz, e] = key.split(',').map(Number);
  refreshEdge(ox, oz, e);
  dbg('RESECURED', key, patchedKeys.has(key) ? '-> locked for good' : '-> backdoor', 'blocks', cleared.size, 'held', exploitedKeys.size);
}

/** The defender has just crossed the middle of a street segment. @param {number} ix @param {number} iz @param {number} dir */
function defenderVisit(ix, iz, dir) {
  const [ox, oz, e] = edgeOwner(ix, iz, dir);
  if (!edgeHasNode(ox, oz, e)) return;
  const key = `${ox},${oz},${e}`;
  const st = nodeStatus(key);
  if (!blueCanTake(st)) return;
  if (st === ST_OPEN) {
    sigKeys.add(key);
    refreshEdge(ox, oz, e);
    dbg('PATCHED untouched (signature)', key);
  } else {
    resecure(key, def.x, def.z);
  }
}

function caughtByDefender() {
  state.caught++;
  state.glitch = 1;
  state.dead = CFG.deadTime;
  state.arc = null;
  state.queued = 0;
  dart.group.visible = false;
  // The dart comes apart into pixels.
  for (let n = 0; n < 420; n++) {
    const a = Math.random() * Math.PI * 2;
    const up = Math.random();
    const v = 3 + Math.random() * 24;
    spawnParticle(
      state.x + (Math.random() - 0.5) * 2, state.y + (Math.random() - 0.3) * 1.2, state.z + (Math.random() - 0.5) * 2,
      Math.cos(a) * v * (1 - up * 0.5), up * 16, Math.sin(a) * v * (1 - up * 0.5),
      0.6 + Math.random() * 1.0, 0.1 + Math.random() * 0.2, 1,
    );
  }
  const loss = Math.max(CFG.catchLoss, Math.ceil(exploitedKeys.size / 2));
  const lost = exploitOrder.slice(-loss);
  for (const q of lost) resecure(q.key, q.x, q.z);
  notice('caught');
  dbg('CAUGHT', 'lost', lost.length, 'exploits, held', exploitedKeys.size);
  def.mode = 'patch';
  def.cooldown = CFG.defCooldown;
  def.planFor = '';
}

/** How many vulnerabilities red must hold at once to win this level. */
function winTarget() {
  return Math.max(1, Math.ceil(level.nodeTotal * CFG.winShare));
}

function checkRoundEnd() {
  if (state.over) return;
  const target = winTarget();
  let reason = '';
  if (exploitedKeys.size >= target) {
    state.over = 'red';
    reason = `payload delivered: ${exploitedKeys.size} of ${level.nodeTotal} vulnerabilities held`;
  } else if (state.caught >= CFG.lives) {
    state.over = 'blue';
    reason = `intruder caught ${state.caught} times`;
  } else if (level.nodeTotal - patchedKeys.size < target) {
    state.over = 'blue';
    reason = `${patchedKeys.size} vulnerabilities locked: red can no longer reach ${target}`;
  }
  if (!state.over) return;
  const el = document.getElementById('banner');
  el.className = state.over;
  el.querySelector('h1').textContent = state.over === 'red' ? 'red team wins' : 'blue team wins';
  el.querySelector('p').textContent = reason;
  el.style.display = 'block';
  dbg('ROUND OVER', state.over, reason);
}

/** Put the hacker back at the intersection furthest from anything worth having. */
function respawnHacker() {
  const P = CFG.pitch;
  /** @type {number[][]} midpoints of every vulnerability still up for grabs */
  const prizes = [];
  for (let iz = 0; iz <= A; iz++) {
    for (let ix = 0; ix <= A; ix++) {
      for (let e = 0; e < 2; e++) {
        if (!edgeHasNode(ix, iz, e)) continue;
        const key = `${ix},${iz},${e}`;
        if (!redCanTake(nodeStatus(key))) continue;
        prizes.push([e === 0 ? (ix + 0.5) * P : ix * P, e === 0 ? iz * P : (iz + 0.5) * P]);
      }
    }
  }
  let best = [START.ix, START.iz];
  let bestScore = -1;
  for (let iz = 0; iz <= A; iz++) {
    for (let ix = 0; ix <= A; ix++) {
      const defGap = Math.abs(ix * P - def.x) + Math.abs(iz * P - def.z);
      if (defGap < CFG.respawnClear * P) continue;
      // Score = distance to the nearest prize. With no prizes left, distance from the defender.
      let score = prizes.length ? Infinity : defGap;
      for (const q of prizes) score = Math.min(score, Math.abs(ix * P - q[0]) + Math.abs(iz * P - q[1]));
      if (score > bestScore) { bestScore = score; best = [ix, iz]; }
    }
  }
  const open = [0, 1, 2, 3].filter((d) => isOpen(best[0], best[1], d));
  const dir = open[Math.floor(Math.random() * open.length)];
  const yaw = -dir * Math.PI / 2;
  Object.assign(state, {
    x: best[0] * P, z: best[1] * P, dir, nextX: best[0] + DIRS[dir][0], nextZ: best[1] + DIRS[dir][1],
    yaw, yawVis: yaw, camYaw: yaw, hx: -Math.sin(yaw), hz: -Math.cos(yaw), roll: 0, arc: null, queued: 0,
    slow: 0, glitch: 1, dead: 0, invuln: CFG.respawnInvuln,
  });
  resetTrail();
  dart.group.visible = true;
  dbg('respawned at', best[0], best[1], 'dir', dir, 'nearest prize', bestScore.toFixed(0), 'units away');
}

/** @param {number} dt */
function updateDefender(dt) {
  const P = CFG.pitch;
  const gap = Math.abs(def.x - state.x) + Math.abs(def.z - state.z);
  def.cooldown = Math.max(0, def.cooldown - dt);
  if (def.mode === 'patch' && def.cooldown <= 0 && gap < CFG.defHuntRange * P) {
    def.mode = 'hunt';
    def.huntT = CFG.defHuntTime;
    def.planFor = '';
    dbg('defender: HUNT');
  } else if (def.mode === 'hunt') {
    def.huntT -= dt;
    if (def.huntT <= 0 || gap > CFG.defLeashRange * P) {
      def.mode = 'patch';
      def.cooldown = CFG.defCooldown;
      def.planFor = '';
      dbg('defender: back to patching');
    }
  }

  let move = CFG.speed * (def.mode === 'hunt' ? CFG.defHuntSpeed : CFG.defSpeed) * dt;
  for (let guard = 0; guard < 4 && move > 1e-6; guard++) {
    if (def.arc) {
      const a = def.arc;
      const step = Math.min(move, (Math.PI / 2 - a.phi) * a.r);
      a.phi += step / a.r;
      move -= step;
      const d0 = DIRS[a.d0];
      const d1 = DIRS[a.d1];
      const sn = Math.sin(a.phi);
      const cs = Math.cos(a.phi);
      def.x = a.ax + d1[0] * a.r * (1 - cs) + d0[0] * a.r * sn;
      def.z = a.az + d1[1] * a.r * (1 - cs) + d0[1] * a.r * sn;
      def.yaw = a.yaw0 - a.sign * a.phi;
      if (a.phi >= Math.PI / 2 - 1e-6) {
        def.yaw = a.yaw0 - a.sign * Math.PI / 2;
        def.dir = a.d1;
        def.nextX += d1[0];
        def.nextZ += d1[1];
        def.arc = null;
        def.lastRem = defDistToNext();
      }
      continue;
    }
    if (def.planFor !== `${def.nextX},${def.nextZ}`) defenderPlan();
    const d = DIRS[def.dir];
    const rem = defDistToNext();
    if (Math.abs(def.plan) === 1 && rem <= CFG.turnRadius + 1e-6) {
      def.arc = { ax: def.x, az: def.z, d0: def.dir, d1: mod(def.dir + def.plan, 4), r: Math.max(rem, 0.5), phi: 0, sign: def.plan, yaw0: def.yaw };
      continue;
    }
    const stop = Math.abs(def.plan) === 1 ? rem - CFG.turnRadius : rem;
    const step = Math.max(0, Math.min(move, stop + 1e-4));
    def.x += d[0] * step;
    def.z += d[1] * step;
    move -= step;
    const after = defDistToNext();
    // Crossing the midpoint of the segment is where a vulnerability sits.
    if (def.lastRem > P / 2 && after <= P / 2) defenderVisit(def.nextX - d[0], def.nextZ - d[1], def.dir);
    def.lastRem = after;
    if (after <= 0 && def.plan === 0) {
      def.nextX += d[0];
      def.nextZ += d[1];
      def.lastRem = P;
    } else if (after <= 0 && def.plan === 2) {
      // Dead end: turn round at the centre and head back out.
      def.dir = mod(def.dir + 2, 4);
      def.yaw += Math.PI;
      def.nextX -= d[0];
      def.nextZ -= d[1];
      def.lastRem = P;
    }
  }

  const prevVis = def.yawVis;
  def.yawVis += (def.yaw - def.yawVis) * (1 - Math.exp(-dt * 20));
  const rollTarget = Math.max(-0.75, Math.min(0.75, ((def.yawVis - prevVis) / dt) * 0.11));
  def.roll += (rollTarget - def.roll) * (1 - Math.exp(-dt * 12));
  defDart.group.position.set(def.x, CFG.hoverY + Math.sin(state.time * 5 + 2) * 0.035, def.z);
  defDart.group.rotation.set(0, def.yawVis, def.roll, 'YXZ');

  const cx = def.x - state.x;
  const cz = def.z - state.z;
  if (state.dead <= 0 && state.invuln <= 0 && cx * cx + cz * cz < CFG.catchRadius * CFG.catchRadius) caughtByDefender();
}

// ---------------------------------------------------------------- camera, post, loop

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.55, 0.62);
composer.addPass(bloom);
const lensPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime, uSpeed: { value: 0 }, uGlitch: { value: 0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSpeed;
    uniform float uTime;
    uniform float uGlitch;
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
      col = mix(col, col * vec3(1.5, 0.45, 0.3) + vec3(0.05, 0.0, 0.0), uGlitch * 0.35);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});
composer.addPass(lensPass);
composer.addPass(new OutputPass());

const camLook = new THREE.Vector3();

/** @param {number} dt */
function updateCamera(dt) {
  state.camYaw += (state.yaw - state.camYaw) * (1 - Math.exp(-dt * (SAVER ? CFG.saverYawRate : CFG.camYawRate)));
  const cx = -Math.sin(state.camYaw);
  const cz = -Math.cos(state.camYaw);
  if (SAVER) {
    // Drifts between street level and partway up the towers over about a minute and a half.
    const lift = 0.5 - 0.5 * Math.cos(state.time * 0.07);
    camera.position.set(state.x - cx * CFG.camBack, 2.2 + lift * 7, state.z - cz * CFG.camBack);
    camLook.set(state.x + cx * 22, 2.2 + lift * 5.5, state.z + cz * 22);
  } else {
    camera.position.set(state.x - cx * CFG.camBack, CFG.camHeight, state.z - cz * CFG.camBack);
    camLook.set(state.x + cx * 14, 1.15, state.z + cz * 14);
  }
  camera.lookAt(camLook);
  camera.rotateZ(state.camRoll * 0.14);
  lensPass.uniforms.uSpeed.value = (state.speed - CFG.speedMin) / (CFG.speedMax - CFG.speedMin);
  lensPass.uniforms.uGlitch.value = state.glitch;
  bloom.strength = 0.5 + state.flash * 0.6;
  const shake = state.glitch * 0.3;
  camera.position.x += (Math.random() - 0.5) * shake;
  camera.position.y += (Math.random() - 0.5) * shake;

  floor.position.x = state.x;
  floor.position.z = state.z;
  mirror.position.x = state.x;
  mirror.position.z = state.z;
  horizon.position.set(camera.position.x, HAZE_HEIGHT / 2, camera.position.z);
  // The red glow under the dart: parked out of sight when there is no dart.
  if (SAVER && !SAVER_CORRUPT) floorMat.uniforms.uDart.value.set(1e6, 1e6);
  else floorMat.uniforms.uDart.value.set(state.x, state.z);
}

// ---------------------------------------------------------------- HUD and minimap

/** @param {string} label */
function hudRow(label) {
  const row = document.createElement('div');
  const value = document.createElement('b');
  row.append(`${label} `, value);
  document.getElementById('hud').append(row);
  return value;
}
const hudLevel = hudRow('level');
const hudSpeed = hudRow('velocity');
const hudExploits = hudRow('exploits held');
const hudPatched = hudRow('locked for good');
const hudRooted = hudRow('rooted for good');
const hudBackdoors = hudRow('contested');
const hudNodes = hudRow('towers corrupted');
const hudHits = hudRow('firewall hits');
const hudCaught = hudRow('lives left');
const hudDef = hudRow('blue team');
const hudTurn = hudRow('next turn');

const mapEl = /** @type {HTMLCanvasElement} */ (document.getElementById('map'));
const mapCtx = mapEl.getContext('2d');
const MAP_BLOCKS = 5;

function updateHud() {
  hudSpeed.textContent = state.speed.toFixed(0);
  hudNodes.textContent = String(state.corrupted);
  hudLevel.textContent = String(level.seed);
  hudExploits.textContent = `${exploitedKeys.size} / ${winTarget()} to win`;
  hudPatched.textContent = `${patchedKeys.size} / ${level.nodeTotal - winTarget() + 1} to win`;
  hudBackdoors.textContent = String(backdoorAt.size + newVulnKeys.size);
  hudRooted.textContent = String(rootedKeys.size);
  hudHits.textContent = String(state.hits);
  hudCaught.textContent = String(Math.max(0, CFG.lives - state.caught));
  hudDef.textContent = def.mode === 'hunt' ? 'HUNTING YOU' : 'patching';
  const turning = state.arc ? (state.arc.sign < 0 ? 'left (turning)' : 'right (turning)') : null;
  const planned = turning ?? (state.queued === 0 ? 'straight' : state.queued < 0 ? 'left' : 'right');
  hudTurn.textContent = state.paused ? 'paused' : state.dead > 0 ? 'caught' : state.noticeT > 0 ? state.notice : planned;

  // Heading-up minimap: the dart always points up, the city turns around it.
  const S = mapEl.width;
  const k = S / (CFG.pitch * MAP_BLOCKS);
  mapCtx.setTransform(1, 0, 0, 1, 0, 0);
  mapCtx.fillStyle = '#1d2021';
  mapCtx.fillRect(0, 0, S, S);
  mapCtx.translate(S / 2, S * 0.62);
  mapCtx.rotate(state.camYaw);
  mapCtx.scale(k, k);
  mapCtx.translate(-state.x, -state.z);

  const bx0 = Math.floor(state.x / CFG.pitch) - MAP_BLOCKS;
  const bz0 = Math.floor(state.z / CFG.pitch) - MAP_BLOCKS;
  const inset = CFG.streetHalf;
  for (let bz = bz0; bz <= bz0 + MAP_BLOCKS * 2; bz++) {
    for (let bx = bx0; bx <= bx0 + MAP_BLOCKS * 2; bx++) {
      const n = blockInfection.get(`${bx},${bz}`) ?? 0;
      mapCtx.fillStyle = n > 0 ? `rgba(251,73,52,${0.25 + 0.75 * Math.min(1, n / 6)})` : '#2f4a3a';
      mapCtx.fillRect(bx * CFG.pitch + inset, bz * CFG.pitch + inset, CFG.pitch - inset * 2, CFG.pitch - inset * 2);
    }
  }

  // Firewalled streets as red bars, vulnerabilities as pale squares (orange once exploited).
  for (const ed of edges) {
    if (Number.isNaN(ed.ix)) continue;
    if (ed.wall) {
      const ew = ed.key.endsWith(',0');
      const reach = CFG.pitch / 2 - inset;
      mapCtx.fillStyle = '#fe8019';
      mapCtx.fillRect(ed.x - (ew ? reach : 2.2), ed.z - (ew ? 2.2 : reach), (ew ? reach : 2.2) * 2, (ew ? 2.2 : reach) * 2);
    } else if (ed.node) {
      // Outer square = who has it now. Centre: the other colour if they can still come back,
      // dark if it is settled for the round.
      const st = ed.st;
      const red = st === ST_RED || st === ST_ROOTED || st === ST_NEWVULN;
      mapCtx.fillStyle = st === ST_OPEN ? '#ebdbb2' : red ? '#fb4934' : '#3d8bff';
      mapCtx.fillRect(ed.x - 3.5, ed.z - 3.5, 7, 7);
      const centre = st === ST_BACKDOOR ? '#fb4934' : st === ST_NEWVULN ? '#3d8bff' : st === ST_ROOTED || st === ST_LOCKED ? '#1d2021' : '';
      if (centre) {
        mapCtx.fillStyle = centre;
        mapCtx.fillRect(ed.x - 1.7, ed.z - 1.7, 3.4, 3.4);
      }
    }
  }

  // Planned path: straight to the next intersection, then the queued turn.
  const d = DIRS[state.dir];
  const ix = state.nextX * CFG.pitch;
  const iz = state.nextZ * CFG.pitch;
  mapCtx.strokeStyle = '#fb4934';
  mapCtx.lineWidth = 2.2;
  mapCtx.beginPath();
  mapCtx.moveTo(state.x, state.z);
  if (!state.arc) {
    mapCtx.lineTo(ix, iz);
    const out = DIRS[mod(state.dir + state.queued, 4)];
    mapCtx.lineTo(ix + out[0] * CFG.pitch * 0.7, iz + out[1] * CFG.pitch * 0.7);
  } else {
    const out = DIRS[state.arc.d1];
    mapCtx.lineTo(state.x + out[0] * CFG.pitch * 0.7 + d[0], state.z + out[1] * CFG.pitch * 0.7 + d[1]);
  }
  mapCtx.stroke();

  mapCtx.fillStyle = '#3d8bff';
  mapCtx.fillRect(def.x - 5, def.z - 5, 10, 10);

  mapCtx.setTransform(1, 0, 0, 1, 0, 0);
  mapCtx.translate(S / 2, S * 0.62);
  mapCtx.rotate(state.camYaw - state.yawVis);
  mapCtx.fillStyle = '#fb4934';
  mapCtx.beginPath();
  mapCtx.moveTo(0, -13);
  mapCtx.lineTo(5, 6);
  mapCtx.lineTo(0, 2);
  mapCtx.lineTo(-5, 6);
  mapCtx.closePath();
  mapCtx.fill();
}

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  mirror.getRenderTarget().setSize(Math.floor(w * renderRatio * 0.5), Math.floor(h * renderRatio * 0.5));
  particles.material.uniforms.uScale.value = h;
  dbg('resize', w, h);
});

// ---------------------------------------------------------------- adaptive resolution
// Nearly all the cost here is pixels: see-through towers drawn over each other, the floor mirror
// and the glow pass. On a weak graphics chip the cheapest fix is to draw fewer pixels and let the
// browser stretch the picture, which this soft, glowing look hides well. It only ever steps down:
// with the frame rate capped by the screen there is no way to see spare capacity to step back up.

let renderRatio = renderer.getPixelRatio();

// A graphics driver can drop the 3D context (driver reset, GPU switch, out of memory). three.js
// rebuilds it when the browser hands it back; these lines make the event visible in the log.
renderer.domElement.addEventListener('webglcontextlost', () => console.warn('[datacore] WebGL context lost'));
renderer.domElement.addEventListener('webglcontextrestored', () => console.warn('[datacore] WebGL context restored'));
let resFrames = 0;
let resT = 0;
let resWarmup = 3;       // seconds ignored after start: the first frames compile shaders

/** @param {number} ratio */
function setRenderRatio(ratio) {
  renderRatio = ratio;
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  mirror.getRenderTarget().setSize(Math.floor(window.innerWidth * ratio * 0.5), Math.floor(window.innerHeight * ratio * 0.5));
}

// Troubleshooting switches. ?scale=0.64 pins the render scale and turns the automatic stepping
// off, to reproduce what a slower machine settled at. ?diag=1 turns on the red-screen watcher below.
const FIXED_SCALE = Number(params.get('scale')) || 0;
if (FIXED_SCALE > 0) {
  setRenderRatio(Math.max(0.25, Math.min(2, FIXED_SCALE)));
  console.info(`[datacore] render scale pinned at ${renderRatio.toFixed(2)}`);
}
const DIAG = params.has('diag') && params.get('diag') !== '0';

// Red-screen watcher. A tester saw the whole picture go red for a couple of seconds on an Intel
// laptop and it could not be reproduced on demand. Once a second this reads two thin strips of
// the finished frame and, if nearly all of it is bright red, logs what the scene was doing.
// Reading pixels back stalls the graphics chip for a moment, hence opt-in only.
const diagStrip = new Uint8Array(48 * 4);
let diagT = 0;
let diagRed = false;

/** @param {number} rawDt */
function watchForRedScreen(rawDt) {
  diagT += rawDt;
  if (diagT < (diagRed ? 0.25 : 1)) return;
  diagT = 0;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  let red = 0;
  let total = 0;
  for (const fy of [0.3, 0.7]) {
    gl.readPixels(Math.floor(w * 0.5) - 24, Math.floor(h * fy), 48, 1, gl.RGBA, gl.UNSIGNED_BYTE, diagStrip);
    for (let i = 0; i < 48; i++) {
      const r = diagStrip[i * 4];
      total++;
      if (r > 140 && r > 2.5 * diagStrip[i * 4 + 1] && r > 2.5 * diagStrip[i * 4 + 2]) red++;
    }
  }
  const isRed = red >= total * 0.9;
  if (isRed === diagRed) return;
  diagRed = isRed;
  console.warn(`[datacore] RED SCREEN ${isRed ? 'began' : 'ended'} ${JSON.stringify({
    t: +state.time.toFixed(2), x: +state.x.toFixed(1), z: +state.z.toFixed(1), dir: state.dir, turning: !!state.arc,
    cam: camera.position.toArray().map((v) => +v.toFixed(2)), camYaw: +state.camYaw.toFixed(3),
    scale: +renderRatio.toFixed(3), buffer: `${w}x${h}`, corrupted: state.corrupted, glitch: state.glitch, flash: state.flash,
    sample: Array.from(diagStrip.slice(0, 8)),
  })}`);
}

/** @param {number} rawDt */
function adaptResolution(rawDt) {
  if (FIXED_SCALE > 0) return;
  if (resWarmup > 0) { resWarmup -= rawDt; return; }
  resFrames++;
  resT += rawDt;
  if (resT < 2) return;
  const fps = resFrames / resT;
  resFrames = 0;
  resT = 0;
  if (fps >= CFG.resFpsFloor || renderRatio <= CFG.resMin) return;
  // Cost is close to proportional to the pixel count, which goes with the square of the scale,
  // so aim straight for the scale that should reach the target instead of creeping down in
  // steps. Each change rebuilds the render buffers, so fewer changes is better.
  const next = Math.max(CFG.resMin, Math.min(renderRatio * 0.9, renderRatio * Math.sqrt(fps / CFG.resFpsTarget)));
  console.info(`[datacore] ${fps.toFixed(0)} fps, lowering render scale ${renderRatio.toFixed(2)} -> ${next.toFixed(2)}`);
  setRenderRatio(next);
}

// ---------------------------------------------------------------- performance readout
// F toggles it. Only what a web page can measure about itself: whole-PC numbers (CPU, memory,
// temperatures) need the desktop build.

const statsEl = document.getElementById('stats');
let statsOn = false;
let statFrames = 0;
let statT = 0;
let statWorst = 0;

// Whole-PC numbers come from serve.py (/api/stats); a web page cannot read them itself.
/** @typedef {{cpu: {percent: number | null, temp_c: number | null}, memory: {used_gb: number, total_gb: number}, gpu: null | {name: string, percent: number, temp_c: number, vram_used_gb: number, vram_total_gb: number}, gpu_error: string}} SysStats */
/** @type {SysStats | null} */
let sysStats = null;
let sysError = '';
let sysBusy = false;
let sysNextAt = 0;

async function pollSysStats() {
  sysBusy = true;
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sysStats = /** @type {SysStats} */ (await res.json());
    if (sysError) dbg('pc stats back');
    sysError = '';
    sysNextAt = performance.now() + 1000;
  } catch (err) {
    // Shown in the panel as well; retried more slowly so a missing helper is not hammered.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== sysError) console.warn('[datacore] pc stats unavailable:', msg);
    sysError = msg;
    sysStats = null;
    sysNextAt = performance.now() + 5000;
  } finally {
    sysBusy = false;
  }
}

/** @param {number | null} v @param {string} unit */
const statNum = (v, unit) => (v === null ? '--' : `${v.toFixed(0)}${unit}`);

/** @param {boolean} on */
function setStats(on) {
  statsOn = on;
  statsEl.style.display = on ? 'block' : 'none';
  localStorage.setItem('datacore.stats', on ? '1' : '0');
  dbg('stats', on);
}
setStats(params.has('stats') ? params.get('stats') !== '0' : localStorage.getItem('datacore.stats') === '1');

// The composer renders several passes a frame; without this the counters only show the last one.
renderer.info.autoReset = false;

/** @param {number} rawDt seconds since the last frame, unclamped */
function updateStats(rawDt) {
  statFrames++;
  statT += rawDt;
  statWorst = Math.max(statWorst, rawDt);
  if (statsOn && !sysBusy && performance.now() >= sysNextAt) void pollSysStats();
  if (statT < 0.5) return;
  if (statsOn) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rows = [
      ['fps', (statFrames / statT).toFixed(0)],
      ['frame', `${(statT / statFrames * 1000).toFixed(1)} ms`],
      ['worst frame', `${(statWorst * 1000).toFixed(1)} ms`],
      ['draw calls', String(renderer.info.render.calls)],
      ['triangles', renderer.info.render.triangles.toLocaleString('en-US')],
      ['render size', `${size.x} x ${size.y}`],
      ['render scale', `${(renderRatio / Math.min(window.devicePixelRatio, 2) * 100).toFixed(0)}%`],
    ];
    // Chrome-family browsers only.
    const mem = /** @type {{memory?: {usedJSHeapSize: number}}} */ (/** @type {unknown} */ (performance)).memory;
    if (mem) rows.push(['page memory', `${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`]);
    if (sysStats) {
      const { cpu, memory, gpu } = sysStats;
      rows.unshift(
        ['cpu', `${statNum(cpu.percent, '%')}  ${statNum(cpu.temp_c, '\u00b0C')}`],
        ['ram', `${memory.used_gb.toFixed(1)} / ${memory.total_gb.toFixed(1)} GB`],
        ...(gpu ? [
          ['gpu', `${statNum(gpu.percent, '%')}  ${statNum(gpu.temp_c, '\u00b0C')}`],
          ['vram', `${gpu.vram_used_gb.toFixed(1)} / ${gpu.vram_total_gb.toFixed(1)} GB`],
        ] : [['gpu', sysStats.gpu_error ? 'read failed' : 'none found']]),
      );
    } else {
      rows.unshift(['pc stats', sysError ? 'helper not running' : 'loading']);
    }
    statsEl.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = value;
      row.append(`${label} `, b);
      return row;
    }));
  }
  statFrames = 0;
  statT = 0;
  statWorst = 0;
}

let lastMs = 0;
let frames = 0;
let fpsT = 0;

/** @param {number} ms */
function frame(ms) {
  const rawDt = (ms - lastMs) / 1000;
  const dt = Math.min(rawDt, 0.05);
  lastMs = ms;
  if (SAVER && dt > 0) {
    state.time += dt;
    uTime.value = state.time;
    saverSteer();
    updateDart(dt);
    dart.group.visible = false;
    updateBlocks();
    updateEdges();
    if (SAVER_CORRUPT) {
      updateInfection();
      saverHeal();
    }
    updateCamera(dt);
  } else if (!state.paused && !state.over && dt > 0) {
    state.time += dt;
    uTime.value = state.time;
    updateDart(dt);
    updateDefender(dt);
    updateBlocks();
    updateEdges();
    updateNodes();
    if (state.dead <= 0) updateInfection();
    updateParticles(dt);
    updateCamera(dt);
    checkRoundEnd();
  }
  if (!SAVER) updateHud();
  // Before the render, never after it: resizing clears the canvas, and a resize that is not
  // followed by a draw in the same frame shows as a blank flash.
  if (rawDt > 0 && rawDt < 1 && !state.paused) adaptResolution(rawDt);
  renderer.info.reset();
  composer.render();
  if (DIAG && rawDt > 0 && rawDt < 1) watchForRedScreen(rawDt);
  if (rawDt > 0 && rawDt < 1) updateStats(rawDt);
  frames++;
  fpsT += dt;
  if (fpsT >= 5) {
    dbg('fps', (frames / fpsT).toFixed(0), 'pos', state.x.toFixed(0), state.z.toFixed(0), 'dir', state.dir, 'turns', state.turns);
    frames = 0;
    fpsT = 0;
  }
}

reset(params.has('seed') ? Number(params.get('seed')) : undefined);
updateCamera(1);
renderer.setAnimationLoop(frame);

// Handle for poking at the game from the console and from automated checks.
Object.assign(window, { __game: { state, def, level, backdoorAt, rootedKeys, sigKeys, newVulnKeys, nodeStatus, winTarget, CFG, towers, edges, exploitedKeys, patchedKeys, isOpen, reset, queueTurn, reverse, distToNext, renderer, scene, camera, composer } });
dbg('ready');
