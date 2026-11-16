// three.js 0.170.0: the copy in ./vendor, with the public CDN as a fallback
let THREE;
try { THREE = await import('./vendor/three.module.min.js'); }
catch (e) {
  try { THREE = await import('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js'); }
  catch (e2) {
    document.getElementById('loadText').textContent = 'The tour could not load.';
    const el = document.getElementById('loadErr'); el.style.display = 'block'; el.textContent = 'The 3D library did not download. Check your connection and reload the page.';
    throw e2;
  }
}

const $ = (s) => document.querySelector(s);
const canvas = $('#view');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EYE = 1.58, RADIUS = 0.2, CELL = 0.05;

// ---------- loading ----------
let total = 1, done = 0;
function tick() { done++; $('#fill').style.width = Math.round(100 * done / total) + '%'; }
async function getJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); }
async function getImage(u) {
  const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status);
  const img = new Image(); img.src = URL.createObjectURL(await r.blob()); await img.decode(); return img;
}
const srgb2lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };

// ---------- shaders: albedo x baked light, exposure, tone curve ----------
const VERT = `
attribute vec2 aLm;
varying vec2 vUv; varying vec2 vLm; varying vec3 vW;
void main() {
  vUv = uv; vLm = aLm;
  vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FRAG = `
uniform sampler2D map; uniform sampler2D lm;
uniform vec3 tint; uniform vec3 emissive; uniform float lmMax; uniform float alpha; uniform float lit; uniform float uvScale; uniform float gloss;
uniform float uExposure; uniform float uOutComp; uniform vec3 uWb; uniform vec4 uHouse;
uniform sampler2D tRefl; uniform vec2 uRes; uniform float uPass;
varying vec2 vUv; varying vec2 vLm; varying vec3 vW;
vec3 neutral(vec3 color) {
  const float start = 0.76; const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
void main() {
  if (uPass > 0.5 && vW.y < 0.002) discard;                    // mirror pass: only what is above the floor
  vec3 alb = texture2D(map, vUv * uvScale).rgb * tint;
  vec3 s = texture2D(lm, vLm).rgb;
  vec3 L = s * s * lmMax;
  float px = vW.x; float py = -vW.z;
  float d = max(max(uHouse.x - px, px - uHouse.z), max(uHouse.y - py, py - uHouse.w));
  float comp = mix(1.0, uOutComp, smoothstep(-0.05, 0.55, d));
  vec3 c = alb * L * uWb * (uExposure * comp) * lit + emissive;
  c = max(neutral(max(c, 0.0)), 0.0);
  c = mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  if (gloss > 0.0 && uPass < 0.5) {                            // soft mirror sheen on the floor (Fresnel)
    vec3 V = normalize(cameraPosition - vW);
    float F = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
    vec2 r = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
    vec2 px = 2.2 / uRes;
    vec3 rc = texture2D(tRefl, r).rgb * 0.28 + 0.18 * (texture2D(tRefl, r + vec2(px.x, px.y)).rgb + texture2D(tRefl, r + vec2(-px.x, px.y)).rgb
            + texture2D(tRefl, r + vec2(px.x, -px.y)).rgb + texture2D(tRefl, r + vec2(-px.x, -px.y)).rgb);
    c = mix(c, rc, clamp(F * gloss, 0.0, 0.55));
  }
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(c, alpha);
}`;
const SKY_VERT = `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;
const SKY_FRAG = `
varying vec3 vDir;
float h(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float n1(float x) { float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h(i), h(i + 1.0), f); }
void main() {
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0.0, 1.0);
  vec3 c = mix(vec3(0.87, 0.93, 0.99), vec3(0.40, 0.62, 0.94), pow(t, 0.5));
  float az = atan(d.z, d.x);
  float line = 0.035 + 0.03 * n1(az * 9.0) + 0.012 * n1(az * 41.0);        // soft distant tree line
  c = mix(vec3(0.50, 0.62, 0.52), c, smoothstep(line - 0.004, line + 0.012, d.y));
  if (d.y < 0.0) c = vec3(0.56, 0.66, 0.52);
  gl_FragColor = vec4(c, 1.0);
}`;

// ---------- globals ----------
const G = { uPass: { value: 0 }, tRefl: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uExposure: { value: 2.1 }, uOutComp: { value: 0.45 }, uWb: { value: new THREE.Vector3(1, 1, 1) }, uHouse: { value: new THREE.Vector4(0, 0, 14.72, 11.47) } };
const LOOK = { expIn: 2.1, expOut: 0.95, compIn: 0.42, compOut: 1.0 };
const S = { x: 10.05, y: 1.0, h: 2.5, pitch: -0.12, path: null, pathS: 0, speed: 1.5, finalLook: null, lookAnim: null, userLooked: false, adapt: 0,
            tour: null, keys: new Set(), moved: false, current: null };
let man, renderer, scene, camera, vcam, reflRT, skyMesh, fan = null, nav, ring, targetRing, pickMeshes = [], texCache = {}, mats = {}, maxAniso = 1;

init().catch((e) => {
  console.error(e);
  $('#loadText').textContent = 'The tour could not load.';
  const el = $('#loadErr'); el.style.display = 'block'; el.textContent = 'Reload the page to try again. (' + (e && e.message ? e.message : e) + ')';
});

async function init() {
  man = await getJSON('scene.json');
  const texNames = new Set(['white.png']);
  for (const m of Object.values(man.materials)) if (m.tex) texNames.add(m.tex);
  const lms = Object.entries(man.lightmaps);
  total = texNames.size + lms.length + 2; tick();
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (e) { throw new Error('This browser could not start 3D graphics (WebGL).'); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;      // the shader writes display colour itself
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(65, 1, 0.06, 500);
  camera.rotation.order = 'YXZ';
  vcam = new THREE.PerspectiveCamera(65, 1, 0.06, 500); vcam.rotation.order = 'YXZ';
  reflRT = new THREE.WebGLRenderTarget(64, 64, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
  reflRT.texture.colorSpace = THREE.NoColorSpace; reflRT.texture.generateMipmaps = false; G.tRefl.value = reflRT.texture;

  const raw = atob(man.geometry); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const bin = bytes.buffer; man.geometry = null; tick();
  await Promise.all([
    ...[...texNames].map((n) => getImage(n).then((img) => { texCache[n] = albedoTex(img); tick(); })),
    ...lms.map(([g, l]) => getImage(l.file).then((img) => { texCache['lm:' + g] = lightTex(img); tick(); })),
  ]);
  if (man.wb) G.uWb.value.set(...man.wb);
  if (man.look) Object.assign(LOOK, man.look);
  const hb = man.plan.house; G.uHouse.value.set(hb[0], hb[1], hb[2], hb[3]);

  buildScene(bin);
  nav = buildNav();
  buildUI();
  const v0 = man.views.find((v) => v.id === 'living') || man.views[0];
  S.x = v0.pos[0]; S.y = v0.pos[1]; const a = lookAngles(v0.pos, v0.look); S.h = a.h; S.pitch = a.pitch; S.current = v0.id; markChip();
  S.adapt = outside(S.x, S.y);
  resize(); addEventListener('resize', resize);
  bindControls();
  renderer.setAnimationLoop(frame);
  frame(performance.now());
  $('#loading').classList.add('done');
  window.__tour = { S, goTo, setPose: (x, y, h, p) => { S.x = x; S.y = y; S.h = h; S.pitch = p; S.path = null; S.adapt = outside(x, y); }, LOOK, G, man, nav, sim: (sec) => { for (let t = 0; t < sec; t += 0.02) { stepTour(0.02); stepMove(0.02); } }, ready: true };
}

function albedoTex(img) {
  const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = maxAniso; t.needsUpdate = true; return t;
}
function lightTex(img) {
  const t = new THREE.Texture(img); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; return t;
}

function material(name, group) {
  const key = name + '|' + group;
  if (mats[key]) return mats[key];
  const d = man.materials[name] || { kind: 'diffuse', tint: [1, 1, 1] };
  const lm = group && man.lightmaps[group];
  const u = {
    map: { value: texCache[d.tex || 'white.png'] || texCache['white.png'] }, lm: { value: lm ? texCache['lm:' + group] : texCache['white.png'] },
    tint: { value: new THREE.Vector3(...d.tint) }, emissive: { value: new THREE.Vector3(0, 0, 0) }, lmMax: { value: lm ? lm.max : 1 },
    alpha: { value: 1 }, lit: { value: 1 }, uvScale: { value: d.uvScale || 1 }, gloss: { value: d.gloss || 0 }, uPass: G.uPass, tRefl: G.tRefl, uRes: G.uRes, uExposure: G.uExposure, uOutComp: G.uOutComp, uWb: G.uWb, uHouse: G.uHouse,
  };
  const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: u });
  if (d.kind === 'emit') { u.lit.value = 0; u.emissive.value.set(2.4, 2.2, 1.9); }
  if (d.kind === 'glass') { u.lit.value = 0; u.emissive.value.set(0.80, 0.88, 0.95); u.alpha.value = 0.10; m.transparent = true; m.depthWrite = false; m.side = THREE.DoubleSide; }
  if (d.kind === 'curtain') { u.alpha.value = 0.84; m.transparent = true; m.side = THREE.DoubleSide; }
  if (name === 'leaf') m.side = THREE.DoubleSide;
  m.userData = { name, group };
  mats[key] = m; return m;
}

function buildScene(bin) {
  for (const m of man.meshes) {
    const v = new Float32Array(bin, m.voff, m.vcount * 7), idx = new Uint32Array(bin, m.ioff, m.icount);
    const ib = new THREE.InterleavedBuffer(v, 7), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 3));
    geo.setAttribute('aLm', new THREE.InterleavedBufferAttribute(ib, 2, 5));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    const kind = (man.materials[m.material] || {}).kind;
    const mesh = new THREE.Mesh(geo, material(m.material, m.group));
    mesh.name = m.name + ':' + m.material;
    mesh.matrixAutoUpdate = true;
    if (kind === 'curtain') mesh.renderOrder = 1;
    if (kind === 'glass') mesh.renderOrder = 2;
    if (m.pivot) {
      if (!fan) { fan = new THREE.Group(); fan.position.set(...m.pivot); scene.add(fan); }
      fan.add(mesh);
    } else scene.add(mesh);
    if (kind !== 'glass' && kind !== 'curtain' && !m.pivot) pickMeshes.push(mesh);
    mesh.userData = { group: m.group, mat: m.material };
  }
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24),
    new THREE.ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }));
  skyMesh.renderOrder = -10; scene.add(skyMesh);
  const rg = new THREE.RingGeometry(0.15, 0.2, 40); rg.rotateX(-Math.PI / 2);
  const rm = () => new THREE.MeshBasicMaterial({ color: 0x9db8ff, transparent: true, opacity: 0.0, depthTest: false });
  ring = new THREE.Mesh(rg, rm()); ring.renderOrder = 5; ring.visible = false; scene.add(ring);
  targetRing = new THREE.Mesh(rg, rm()); targetRing.renderOrder = 5; targetRing.visible = false; scene.add(targetRing);
}

// ---------- navigation grid ----------
function inPoly(poly, x, y) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inRect = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
function buildNav() {
  const x0 = 3.3, y0 = -2.7, x1 = 14.9, y1 = 8.8;
  const w = Math.ceil((x1 - x0) / CELL), h = Math.ceil((y1 - y0) / CELL);
  const open = new Uint8Array(w * h);
  const rects = [...man.nav.free];
  for (const t of man.plan.thresholds) rects.push(t.rect);
  const doorRects = [];
  for (const o of man.plan.openings) {            // door openings are narrower than the wall gap: block the rest
    if (o.kind === 'window') continue;
    doorRects.push(o.axis === 'x' ? [o.a0 + 0.03, o.c0 - 0.02, o.a1 - 0.03, o.c1 + 0.02] : [o.c0 - 0.02, o.a0 + 0.03, o.c1 + 0.02, o.a1 - 0.03]);
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + (i + 0.5) * CELL, y = y0 + (j + 0.5) * CELL;
    let ok = man.plan.rooms.some((r) => inPoly(r.poly, x, y)) || man.nav.free.some((r) => inRect(r, x, y));
    if (!ok && rects.some((r) => inRect(r, x, y))) ok = doorRects.some((r) => inRect(r, x, y));
    if (ok && man.nav.obstacles.some((r) => inRect(r, x, y))) ok = false;
    open[j * w + i] = ok ? 1 : 0;
  }
  const rr = Math.ceil(RADIUS / CELL), free = new Uint8Array(w * h);
  const offs = [];
  for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) if (di * di + dj * dj <= rr * rr) offs.push([di, dj]);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!open[j * w + i]) continue;
    let ok = true;
    for (const [di, dj] of offs) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= w || b >= h || !open[b * w + a]) { ok = false; break; }
    }
    free[j * w + i] = ok ? 1 : 0;
  }
  const N = { x0, y0, w, h, free };
  N.cell = (x, y) => [Math.floor((x - x0) / CELL), Math.floor((y - y0) / CELL)];
  N.ok = (x, y) => { const [i, j] = N.cell(x, y); return i >= 0 && j >= 0 && i < w && j < h && free[j * w + i] === 1; };
  N.pos = (i, j) => [x0 + (i + 0.5) * CELL, y0 + (j + 0.5) * CELL];
  N.nearest = (x, y, maxR = 1.6) => {
    if (N.ok(x, y)) return [x, y];
    const [ci, cj] = N.cell(x, y); const R = Math.ceil(maxR / CELL); let best = null, bd = 1e9;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= w || j >= h || !free[j * w + i]) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = [i, j]; }
    }
    return best ? N.pos(best[0], best[1]) : null;
  };
  N.los = (ax, ay, bx, by) => {
    const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(d / (CELL * 0.5)));
    for (let k = 0; k <= n; k++) if (!N.ok(ax + (bx - ax) * k / n, ay + (by - ay) * k / n)) return false;
    return true;
  };
  return N;
}
function findPath(sx, sy, tx, ty) {
  const N = nav; const s = N.nearest(sx, sy, 1.0), t = N.nearest(tx, ty, 1.6);
  if (!s || !t) return null;
  if (N.los(s[0], s[1], t[0], t[1])) return [[sx, sy], t];
  const [si, sj] = N.cell(s[0], s[1]), [ti, tj] = N.cell(t[0], t[1]);
  const w = N.w, h = N.h, n = w * h, g = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
  const heap = []; const push = (f, id) => { heap.push([f, id]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const hh = (i, j) => { const dx = Math.abs(i - ti), dy = Math.abs(j - tj); return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy); };
  const sid = sj * w + si, tid = tj * w + ti; g[sid] = 0; push(hh(si, sj), sid);
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];
  let found = false;
  while (heap.length) {
    const [, id] = pop(); if (closed[id]) continue; closed[id] = 1;
    if (id === tid) { found = true; break; }
    const i = id % w, j = (id / w) | 0;
    for (const [di, dj, c] of NB) {
      const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const nid = b * w + a; if (!N.free[nid] || closed[nid]) continue;
      if (di && dj && (!N.free[j * w + a] || !N.free[b * w + i])) continue;
      const ng = g[id] + c; if (ng < g[nid]) { g[nid] = ng; from[nid] = id; push(ng + hh(a, b), nid); }
    }
  }
  if (!found) return null;
  const cells = []; for (let id = tid; id !== -1; id = from[id]) cells.push(id); cells.reverse();
  const pts = cells.map((id) => N.pos(id % w, (id / w) | 0)); pts[0] = [sx, sy]; pts[pts.length - 1] = t;
  const out = [pts[0]]; let i = 0;                         // string-pull with line-of-sight checks
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !N.los(pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
    out.push(pts[j]); i = j;
  }
  return out;
}

// ---------- movement ----------
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function lookAngles(pos, look) {
  const dx = look[0] - pos[0], dy = look[1] - pos[1];
  return { h: Math.atan2(dy, dx), pitch: Math.atan2((look[2] ?? EYE) - EYE, Math.hypot(dx, dy)) };
}
function outside(x, y) {
  const hb = man.plan.house; const d = Math.max(hb[0] - x, x - hb[2], hb[1] - y, y - hb[3]);
  return Math.min(1, Math.max(0, (d + 0.35) / 1.0));
}
function walkTo(x, y, opts = {}) {
  const p = findPath(S.x, S.y, x, y); if (!p) return false;
  let len = 0; const cum = [0];
  for (let i = 1; i < p.length; i++) { len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); cum.push(len); }
  if (len < 0.03) { if (opts.look) S.lookAnim = { ...lookAngles([S.x, S.y], opts.look), t: 0 }; return true; }
  S.path = { p, cum, len }; S.pathS = 0; S.speed = opts.speed || 1.5; S.finalLook = opts.look || null; S.lookAnim = null; S.userLooked = false;
  const e = p[p.length - 1]; targetRing.position.set(e[0], 0.015, -e[1]); targetRing.visible = !opts.quiet; targetRing.material.opacity = 0.9;
  return true;
}
function goTo(id, opts = {}) {
  const v = man.views.find((q) => q.id === id); if (!v) return;
  S.current = id; markChip();
  if (reduceMotion || opts.jump) { S.x = v.pos[0]; S.y = v.pos[1]; const a = lookAngles(v.pos, v.look); S.h = a.h; S.pitch = a.pitch; S.path = null; return; }
  if (!walkTo(v.pos[0], v.pos[1], { look: v.look, speed: opts.speed || 2.3, quiet: true })) { S.x = v.pos[0]; S.y = v.pos[1]; }
}
function pointOnPath(s) {
  const { p, cum } = S.path; let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
  return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t];
}
function stepMove(dt) {
  if (S.path) {
    const { len } = S.path; const ramp = Math.min(1, (S.pathS + 0.12) / 0.5, (len - S.pathS + 0.1) / 0.6);
    S.pathS = Math.min(len, S.pathS + S.speed * Math.max(0.25, ramp) * dt);
    const [x, y] = pointOnPath(S.pathS); S.x = x; S.y = y;
    if (!S.userLooked) {
      let th, tp = -0.06;
      const remaining = len - S.pathS;
      if (S.finalLook && remaining < 1.3) { const a = lookAngles([x, y], S.finalLook); th = a.h; tp = a.pitch; }
      else { const [ax, ay] = pointOnPath(Math.min(len, S.pathS + 0.9)); th = (Math.hypot(ax - x, ay - y) > 0.05) ? Math.atan2(ay - y, ax - x) : S.h; }
      const k = 1 - Math.exp(-dt * 3.2); S.h += wrap(th - S.h) * k; S.pitch += (tp - S.pitch) * k;
    }
    if (S.pathS >= len - 1e-4) {
      if (S.finalLook && !S.userLooked) S.lookAnim = { ...lookAngles([S.x, S.y], S.finalLook) };
      S.path = null; S.finalLook = null;
    }
  } else if (S.lookAnim) {
    const k = 1 - Math.exp(-dt * 4); const dh = wrap(S.lookAnim.h - S.h), dp = S.lookAnim.pitch - S.pitch;
    S.h += dh * k; S.pitch += dp * k; if (Math.abs(dh) + Math.abs(dp) < 0.004) S.lookAnim = null;
  }
  if (targetRing.visible) { if (!S.path) { targetRing.material.opacity -= dt * 2.5; if (targetRing.material.opacity <= 0) targetRing.visible = false; } }
  // keyboard
  const K = S.keys; let f = 0, s = 0, turn = 0;
  if (K.has('KeyW') || K.has('ArrowUp')) f += 1; if (K.has('KeyS') || K.has('ArrowDown')) f -= 1;
  if (K.has('KeyA')) s -= 1; if (K.has('KeyD')) s += 1;
  if (K.has('ArrowLeft') || K.has('KeyQ')) turn += 1; if (K.has('ArrowRight') || K.has('KeyE')) turn -= 1;
  if (turn) S.h += turn * 1.7 * dt;
  if (f || s) {
    const n = Math.hypot(f, s), v = 1.9 * dt / n, ch = Math.cos(S.h), sh = Math.sin(S.h);
    const dx = (f * ch + s * sh) * v, dy = (f * sh - s * ch) * v;
    if (nav.ok(S.x + dx, S.y + dy)) { S.x += dx; S.y += dy; }
    else if (nav.ok(S.x + dx, S.y)) S.x += dx;
    else if (nav.ok(S.x, S.y + dy)) S.y += dy;
    S.current = null; markChip();
  }
}

// ---------- tour ----------
const TOUR = ['porch', 'living', 'dining', 'lounge', 'corridor', 'kitchen'];
function setTour(on) {
  S.tour = on ? { i: -1, wait: 0 } : null;
  $('#tourBtn span').textContent = on ? 'Stop tour' : 'Guided tour';
  $('#tourBtn svg path').setAttribute('d', on ? 'M1 1h8v8H1z' : 'M1 0l9 5-9 5z');
}
function stepTour(dt) {
  const T = S.tour; if (!T) return;
  if (S.path || S.lookAnim) return;
  T.wait -= dt;
  if (T.i >= 0 && T.wait > 0) { if (!reduceMotion) S.h += 0.035 * dt * (T.i % 2 ? 1 : -1); return; }
  T.i++;
  if (T.i >= TOUR.length) { setTour(false); return; }
  goTo(TOUR[T.i], { speed: 1.25 }); T.wait = 4.2;
}

// ---------- controls ----------
function bindControls() {
  let down = null; const pts = new Map();
  const cancelAuto = () => { if (S.tour) setTour(false); };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false }; canvas.classList.add('dragging'); hideHint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pts.has(e.pointerId) && down) {
      const [px, py] = pts.get(e.pointerId); const dx = e.clientX - px, dy = e.clientY - py; pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down.moved = true; cancelAuto(); }
      if (down.moved) {
        const k = 0.0042 * (camera.fov / 65);
        S.h += dx * k; S.pitch = Math.max(-1.2, Math.min(1.2, S.pitch + dy * k)); S.userLooked = true; S.lookAnim = null; ring.visible = false;
      }
    } else if (e.pointerType === 'mouse') hover(e);
  });
  const up = (e) => {
    pts.delete(e.pointerId); canvas.classList.remove('dragging');
    if (down && !down.moved && performance.now() - down.t < 500) { cancelAuto(); click(e); }
    down = null;
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); down = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('pointerleave', () => { ring.visible = false; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = Math.max(0.6, Math.min(1.25, (S.zoom || 1) * (e.deltaY > 0 ? 1.06 : 0.94))); resize(); }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLButtonElement && (e.code === 'Space' || e.code === 'Enter')) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      S.keys.add(e.code); S.path = null; S.lookAnim = null; cancelAuto(); hideHint(); e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => S.keys.delete(e.code));
  addEventListener('blur', () => S.keys.clear());
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(e) {
  const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera); ray.far = 40;
  const hit = ray.intersectObjects(pickMeshes, false)[0]; if (!hit) return null;
  if (hit.point.y > 2.3) return null;
  const x = hit.point.x, y = -hit.point.z;
  const onFloor = hit.object.userData.group === 'floor' || hit.point.y < 0.05;
  const t = nav.nearest(x, y, onFloor ? 0.9 : 1.5); if (!t) return null;
  return { t, onFloor };
}
let lastHover = 0;
function hover(e) {
  const now = performance.now(); if (now - lastHover < 50) return; lastHover = now;
  const p = pick(e);
  if (p && p.onFloor) { ring.position.set(p.t[0], 0.015, -p.t[1]); ring.visible = true; ring.material.opacity = 0.55; } else ring.visible = false;
}
function click(e) { const p = pick(e); if (p) { S.current = null; markChip(); walkTo(p.t[0], p.t[1]); } }
function hideHint() { $('#hint').classList.add('gone'); }

// ---------- UI ----------
function markChip() { document.querySelectorAll('#bar .chip[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.current ? 'true' : 'false')); }
let mapStatic, mapScale, mapX0, mapY1;
function buildUI() {
  const bar = $('#bar');
  for (const v of man.views) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.view = v.id; b.textContent = v.name;
    b.addEventListener('click', () => { if (S.tour) setTour(false); hideHint(); goTo(v.id); });
    bar.appendChild(b);
  }
  $('#tourBtn').addEventListener('click', () => { hideHint(); setTour(!S.tour); });
  const fb = $('#finBtn'), fp = $('#finPanel');
  fb.addEventListener('click', () => { const o = !fp.classList.contains('open'); fp.classList.toggle('open', o); fb.setAttribute('aria-expanded', o ? 'true' : 'false'); });
  const swatch = (host, items, apply) => {
    items.forEach((it, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      const sw = document.createElement('i'); sw.style.background = it.css; b.append(sw, document.createTextNode(it.name));
      b.addEventListener('click', async () => { host.querySelectorAll('button').forEach((q) => q.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); await apply(it); });
      host.appendChild(b);
    });
  };
  swatch($('#swFloor'), [{ name: 'Oak', css: '#cba77e', tex: 'oak_floor.jpg' }, { name: 'Walnut', css: '#79583e', tex: 'walnut_floor.jpg' }, { name: 'Ash', css: '#d6cbba', tex: 'ash_floor.jpg' }], async (it) => {
    if (!texCache[it.tex]) { try { texCache[it.tex] = albedoTex(await getImage(it.tex)); } catch (e) { return; } }
    for (const m of Object.values(mats)) if (m.userData.name === 'floor_wood') m.uniforms.map.value = texCache[it.tex];
  });
  swatch($('#swSofa'), [{ name: 'Royal blue', css: '#244cc0', rgb: [36, 76, 192] }, { name: 'Forest', css: '#2f5d47', rgb: [47, 93, 71] }, { name: 'Charcoal', css: '#3e424a', rgb: [62, 66, 74] }, { name: 'Sand', css: '#c6b294', rgb: [198, 178, 148] }], (it) => {
    const t = it.rgb.map(srgb2lin);
    for (const m of Object.values(mats)) if (m.userData.name === 'fabric_sofa' || m.userData.name === 'fabric_chair') m.uniforms.tint.value.set(t[0], t[1], t[2]);
  });
  // minimap: drawn from the same traced plan data as the 3D model
  const mc = $('#map'), W = mc.width, Hh = mc.height; const bx0 = 3.2, bx1 = 14.95, by0 = -2.75, by1 = 8.75;
  mapScale = Math.min(W / (bx1 - bx0), Hh / (by1 - by0)); mapX0 = bx0 - (W / mapScale - (bx1 - bx0)) / 2; mapY1 = by1 + (Hh / mapScale - (by1 - by0)) / 2;
  mapStatic = document.createElement('canvas'); mapStatic.width = W; mapStatic.height = Hh;
  const c = mapStatic.getContext('2d'); const X = (x) => (x - mapX0) * mapScale, Y = (y) => (mapY1 - y) * mapScale;
  const R = (r, col) => { c.fillStyle = col; c.fillRect(X(r[0]), Y(r[3]), (r[2] - r[0]) * mapScale, (r[3] - r[1]) * mapScale); };
  c.fillStyle = '#e9eef4'; c.fillRect(0, 0, W, Hh);
  const fc = { wood: '#ecdcc2', tile: '#d3d9e0', stone: '#e1dcd2' };
  for (const r of man.plan.rooms) { c.fillStyle = fc[r.floor]; c.beginPath(); r.poly.forEach((p, i) => (i ? c.lineTo(X(p[0]), Y(p[1])) : c.moveTo(X(p[0]), Y(p[1])))); c.closePath(); c.fill(); }
  for (const t of man.plan.thresholds) R(t.rect, fc[t.floor]);
  R(man.plan.porch.rect, fc.stone);
  R(man.nav.rug, '#9fb4ea');
  for (const f of man.nav.furniture) R(f, '#5b7fd6');
  c.save(); c.beginPath(); c.rect(X(3.15), Y(8.62), (14.75 - 3.15) * mapScale, (8.62 + 0.02) * mapScale); c.clip();
  for (const w of man.plan.walls) R(w, '#14203a');
  c.restore();
  for (const o of man.plan.openings) {
    const r = o.axis === 'x' ? [o.a0, o.c0, o.a1, o.c1] : [o.c0, o.a0, o.c1, o.a1];
    if (o.kind === 'window') R(r, '#8fb8e8'); else if (o.kind === 'cased' || o.state === 'open') R([r[0] + 0.0, r[1] + 0.0, r[2], r[3]], fc.wood);
    else R(r, '#b48a5c');
  }
  for (const p of man.plan.porch.posts) R(p, '#14203a');
  const toPlan = (e) => { const r = mc.getBoundingClientRect(); return [mapX0 + ((e.clientX - r.left) / r.width) * W / mapScale, mapY1 - ((e.clientY - r.top) / r.height) * Hh / mapScale]; };
  mc.addEventListener('click', (e) => { const [x, y] = toPlan(e); const t = nav.nearest(x, y, 2.5); if (t) { if (S.tour) setTour(false); hideHint(); S.current = null; markChip(); walkTo(t[0], t[1], { speed: 2.2 }); } });
}
let mapKey = '';
function drawMap() {
  const key = S.x.toFixed(2) + S.y.toFixed(2) + S.h.toFixed(2); if (key === mapKey) return; mapKey = key;
  const mc = $('#map'), c = mc.getContext('2d'); c.drawImage(mapStatic, 0, 0);
  const x = (S.x - mapX0) * mapScale, y = (mapY1 - S.y) * mapScale, a = -S.h, sp = 0.55;
  c.fillStyle = 'rgba(36,80,196,0.22)'; c.beginPath(); c.moveTo(x, y); c.arc(x, y, 78, a - sp, a + sp); c.closePath(); c.fill();
  c.fillStyle = '#2450c4'; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.arc(x, y, 10, 0, 7); c.fill(); c.stroke();
}

// ---------- frame ----------
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  const pr = renderer.getPixelRatio(); G.uRes.value.set(Math.floor(w * pr), Math.floor(h * pr));
  reflRT.setSize(Math.max(64, Math.round(w * pr * 0.4)), Math.max(64, Math.round(h * pr * 0.4)));
  const hf = 92 * Math.PI / 180; let vf = 2 * Math.atan(Math.tan(hf / 2) / camera.aspect) * 180 / Math.PI;
  camera.fov = Math.max(50, Math.min(84, vf)) * (S.zoom || 1); camera.updateProjectionMatrix();
}
let last = 0;
function frame(now) {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000)); last = now;
  stepTour(dt); stepMove(dt);
  const o = outside(S.x, S.y); S.adapt += (o - S.adapt) * (1 - Math.exp(-dt * 3));
  G.uExposure.value = LOOK.expIn + (LOOK.expOut - LOOK.expIn) * S.adapt; G.uOutComp.value = LOOK.compIn + (LOOK.compOut - LOOK.compIn) * S.adapt;
  camera.position.set(S.x, EYE, -S.y); camera.rotation.set(S.pitch, S.h - Math.PI / 2, 0);
  skyMesh.position.copy(camera.position);
  if (fan && !reduceMotion) fan.rotation.y -= dt * 2.2;
  // mirror pass for the floor sheen: same camera reflected in the floor plane (the shader flips it back vertically)
  vcam.fov = camera.fov; vcam.aspect = camera.aspect; vcam.updateProjectionMatrix();
  vcam.position.set(S.x, -EYE, -S.y); vcam.rotation.set(-S.pitch, S.h - Math.PI / 2, 0);
  ring.visible && (ring.userData.v = true, ring.visible = false); const tv = targetRing.visible; targetRing.visible = false;
  G.uPass.value = 1; renderer.setRenderTarget(reflRT); renderer.render(scene, vcam); renderer.setRenderTarget(null); G.uPass.value = 0;
  if (ring.userData.v) { ring.visible = true; ring.userData.v = false; } targetRing.visible = tv;
  renderer.render(scene, camera);
  drawMap();
}
