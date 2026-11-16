import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { NavGrid } from './nav.js?v=20261116-runtime-perf-v1';
import { DoorManager } from './doors.js?v=20261116-runtime-perf-v1';
import { HUD } from './ui.js?v=20261116-runtime-perf-v1';
import { prepareStaticModel } from './static_scene.js?v=20261116-runtime-perf-v1';
import { advancePlayer } from './frame_time.js?v=20261116-runtime-perf-v1';

const canvas = document.getElementById('scene');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const params = new URLSearchParams(location.search);
const lite = params.get('lite') === '1';
const nolock = params.get('nolock') === '1';
const hostSession=params.get('session');
let hostBridge=null;
try {
  if(params.get('embedded')==='1' && parent!==window && parent.location.origin===location.origin && parent.gimLevelHost?.owns(window,hostSession))hostBridge=parent.gimLevelHost;
} catch { /* Standalone or cross-origin pages use ordinary canvas input. */ }
if(hostBridge)document.documentElement.classList.add('embedded');
function pointerLocked(){return document.pointerLockElement===canvas || !!hostBridge?.isLocked(window,hostSession)}
function releasePointerLock(){
  if(document.pointerLockElement===canvas)document.exitPointerLock();
  hostBridge?.releaseLock(window,hostSession);
}
function notifyHost(type,extra={}){if(hostBridge)parent.postMessage({type,session:hostSession,...extra},location.origin)}
// Bump when scene.json or the GLB changes, so a normal reload cannot keep the
// previous 20 MB asset from the browser cache.
const ASSET_VERSION = '20261116-runtime-perf-v1';

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(lite ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.shadowMap.enabled = !lite;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xb9cdda, 170, 560);

const camera = new THREE.PerspectiveCamera(64, window.innerWidth / window.innerHeight, 0.06, 2000);
camera.rotation.order = 'YXZ';
scene.add(camera);

const clock = { last: performance.now() };
const keys = Object.create(null);
const touchMove = { x: 0, y: 0 };
const player = {
  px: 93, py: -20.5, feet: -0.28, eye: 1.68,
  yaw: THREE.MathUtils.degToRad(90), pitch: 0,
  bob: 0, bobPhase: 0, moving: false, indoors: false, lastLabel: '',
  vz: 0, grounded: true,
};
let sceneData = null;
let nav = null;
let hud = null;
let doors = null;
let world = null;
let started = false;
let loaded = false;
let helpOpen = false;
let mapOpen = false;
let pausedBeforeMap = false;
let dragging = false;
let lockEver = false;
let lastPointer = { x: 0, y: 0 };
let sunLight = null;
let flashlight = null;
let flashlightOn = false;
let lastStepTime = 0;
let lastZone = '';
let errors = [];
let audio = null;
let renderPaused = false;
let controlsPaused = false;
let pausedBeforeHelp = false;
let runtimeFailure = null;
let landmarkGroup = null;
let mouseGuardUntil = 0;
let lockYaw = 0;
let lockPitch = 0;
let qualityScale = 1;
let lowFpsTime = 0;
let highFpsTime = 0;
let qualityNotified = false;

// ---------------------------------------------------------------------------
// loading helpers

function setLoading(p, status) {
  if (hud) hud.setLoading(p, status);
  else {
    const bar = document.getElementById('progress-bar');
    const txt = document.getElementById('progress-text');
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    if (txt) txt.textContent = `${Math.round(p * 100)}%`;
    if (status) document.getElementById('loader-status').textContent = status;
  }
}

function fatal(message) {
  errors.push(message);
  const status = document.getElementById('loader-status');
  if (status) status.textContent = message;
  console.error(message);
}

// ---------------------------------------------------------------------------
// scene setup

function setupSky() {
  const sky = new Sky();
  sky.scale.setScalar(1500);
  scene.add(sky);
  const u = sky.material.uniforms;
  u.turbidity.value = 6.5;
  u.rayleigh.value = 1.7;
  u.mieCoefficient.value = 0.0045;
  u.mieDirectionalG.value = 0.8;
  const elevation = THREE.MathUtils.degToRad(33);
  const azimuth = THREE.MathUtils.degToRad(138);
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
  u.sunPosition.value.copy(sunPos);

  sunLight = new THREE.DirectionalLight(0xfff0d6, 2.8);
  sunLight.position.copy(sunPos).multiplyScalar(280);
  sunLight.target.position.set(28, 0, 5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -130;
  sunLight.shadow.camera.right = 130;
  sunLight.shadow.camera.top = 130;
  sunLight.shadow.camera.bottom = -130;
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 520;
  sunLight.shadow.bias = -0.00035;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const hemi = new THREE.HemisphereLight(0xd8eaff, 0x3a392a, 1.05);
  scene.add(hemi);
}

function setupEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.035).texture;
  scene.environmentIntensity = 0.55;
  room.dispose?.();
  pmrem.dispose();
}

function makeNoiseTexture(base, speck, size = 512, density = 5200) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < density; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = 0.5 + rnd() * 2.4;
    const a = 0.02 + rnd() * 0.07;
    g.fillStyle = `rgba(${speck[0]},${speck[1]},${speck[2]},${a})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(0,0,0,${0.015 + rnd() * 0.03})`;
    g.beginPath();
    g.ellipse(rnd() * size, rnd() * size, 20 + rnd() * 80, 8 + rnd() * 30, rnd() * 3.14, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function ensurePlanarUVs(mesh, scale = 0.05) {
  const pos = mesh.geometry.attributes.position;
  if (!pos) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) * scale;
    uv[i * 2 + 1] = pos.getZ(i) * scale;
  }
  mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  mesh.geometry.attributes.uv.needsUpdate = true;
}

function setupGround(worldRoot) {
  const ground = worldRoot.getObjectByName('Ground');
  if (ground) {
    ensurePlanarUVs(ground, 0.055);
    const tex = makeNoiseTexture('#4c4c38', [120, 118, 86], 512, 6500);
    ground.material = new THREE.MeshStandardMaterial({ map: tex, color: 0xb8b8a0, roughness: 0.98, metalness: 0 });
    ground.material.map.needsUpdate = true;
    ground.receiveShadow = true;
  }
  const path = worldRoot.getObjectByName('Entry_Path');
  if (path) {
    ensurePlanarUVs(path, 0.22);
    const tex = makeNoiseTexture('#292c2d', [150, 150, 140], 256, 2600);
    path.material = new THREE.MeshStandardMaterial({ map: tex, color: 0xa8aaa8, roughness: 0.94, metalness: 0 });
    path.receiveShadow = true;
  }
}

function addInteriorLights() {
  const spots = [
    [51, 6.5, 3.45], [31, 6.5, 3.45], [11, 6.5, 3.45], [-5, 6.5, 3.45],
    [48, -37.5, 3.4], [28, -37.5, 3.4], [8, -37.5, 3.4], [56, -16, 3.4], [56, -30, 3.4],
  ];
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1cd });
  for (const [x, y, z] of spots) {
    const light = new THREE.PointLight(0xffe3b8, 28, 19, 1.9);
    light.position.set(x, z, -y);
    scene.add(light);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.045, 0.75), lampMat);
    lamp.position.set(x, z - 0.02, -y);
    scene.add(lamp);
  }
}

function addLandmarkLabels() {
  const group = new THREE.Group();
  group.name = 'LandmarkLabels';
  const defs = (sceneData.landmarks || []).map((l) => {
    let y = 7;
    let color = '#74dcff';
    if (l.kind === 'gate' || l.kind === 'entrance') { y = 6.2; color = '#ffae57'; }
    else if (l.kind === 'building') y = 18;
    else if (l.kind === 'yard') y = 11;
    return { ...l, y, color };
  });
  for (const d of defs) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(4,14,21,0.78)';
    g.strokeStyle = d.color;
    g.lineWidth = 3;
    const r = 18;
    g.beginPath();
    g.moveTo(r, 6); g.lineTo(512 - r, 6); g.quadraticCurveTo(506, 6, 506, 22);
    g.lineTo(506, 106); g.quadraticCurveTo(506, 122, 490, 122);
    g.lineTo(r, 122); g.quadraticCurveTo(6, 122, 6, 106);
    g.lineTo(6, 22); g.quadraticCurveTo(6, 6, r, 6); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = d.color;
    g.font = '600 54px "Microsoft YaHei", "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(d.label, 256, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, toneMapped: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(d.pos[0], d.y, -d.pos[1]);
    sp.scale.set(4.0, 1.0, 1);
    sp.userData.landmark = d.id;
    sp.userData.baseWidth = 4.0;
    group.add(sp);
  }
  scene.add(group);
  return group;
}

function updateLandmarkLabels() {
  if (!landmarkGroup || !landmarkGroup.visible) return;
  const cp = camera.position;
  for (const sp of landmarkGroup.children) {
    const d = cp.distanceTo(sp.position);
    const near = Math.max(0, Math.min(1, (d - 11) / 9));
    const far = Math.max(0, Math.min(1, (210 - d) / 60));
    const a = near * far;
    sp.visible = a > 0.015;
    sp.material.opacity = 0.92 * a;
    const w = Math.min(13, Math.max(2.8, d * 0.13));
    sp.scale.set(w, w * 0.25, 1);
  }
}

function setupFlashlight() {
  flashlight = new THREE.SpotLight(0xfff3da, 0, 42, 0.5, 0.55, 1.4);
  flashlight.position.set(0, 0, 0);
  flashlight.target.position.set(0, -0.1, -1);
  camera.add(flashlight);
  camera.add(flashlight.target);
}

function addTrees() {
  let seed = 20261108;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const positions = [];
  for (let i = 0; i < 90 && positions.length < 64; i++) {
    const x = -80 + rnd() * 220;
    const y = -115 + rnd() * 245;
    // Keep the compound and approach clear.
    if (x > -35 && x < 105 && y > -72 && y < 92) continue;
    if (x > 70 && x < 115 && y > -32 && y < -5) continue;
    positions.push([x, y, 0.8 + rnd() * 0.9, 0.85 + rnd() * 0.55]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 2.4, 6);
  const crownGeo = new THREE.ConeGeometry(1.65, 4.4, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3e5c3e, roughness: 1, flatShading: true });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, positions.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  positions.forEach(([x, y, scale, crownScale], i) => {
    dummy.position.set(x, -0.28 + 1.2 * scale, -y);
    dummy.scale.set(scale, scale, scale);
    dummy.rotation.y = rnd() * Math.PI * 2;
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x + (rnd() - 0.5) * 0.4, -0.28 + 2.4 * scale + 2.2 * crownScale, -y);
    dummy.scale.set(crownScale, crownScale, crownScale);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.29 + rnd() * 0.05, 0.22 + rnd() * 0.12, 0.22 + rnd() * 0.12);
    crowns.setColorAt(i, color);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.castShadow = false;
  crowns.castShadow = false;
  trunks.receiveShadow = true;
  crowns.receiveShadow = true;
  scene.add(trunks, crowns);
}

function addDust() {
  const count = 320;
  const positions = new Float32Array(count * 3);
  let seed = 9001;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    positions[i * 3] = -20 + rnd() * 100;
    positions[i * 3 + 1] = 0.4 + rnd() * 14;
    positions[i * 3 + 2] = -60 + rnd() * 90;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xfff3d4, size: 0.035, transparent: true, opacity: 0.4, depthWrite: false, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  return points;
}

// ---------------------------------------------------------------------------
// audio

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.hum = null;
  }
  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    this.master.connect(this.ctx.destination);
    // Low electrical hum.
    const humGain = this.ctx.createGain();
    humGain.gain.value = 0.018;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const o1 = this.ctx.createOscillator();
    o1.type = 'sine'; o1.frequency.value = 50;
    const o2 = this.ctx.createOscillator();
    o2.type = 'sine'; o2.frequency.value = 100;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.4;
    o1.connect(humGain); o2.connect(g2); g2.connect(humGain); humGain.connect(lp); lp.connect(this.master);
    o1.start(); o2.start();
    // Soft wind noise.
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.985 + (Math.random() * 2 - 1) * 0.015;
      data[i] = last;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const wg = this.ctx.createGain(); wg.gain.value = 0.025;
    const wf = this.ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 500; wf.Q.value = 0.5;
    src.connect(wf); wf.connect(wg); wg.connect(this.master); src.start();
    this.hum = { humGain, wg };
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{}); }
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return !this.muted;
  }
  creak(open) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const len = 0.55;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
    bp.frequency.setValueAtTime(open ? 320 : 420, t);
    bp.frequency.exponentialRampToValueAtTime(open ? 760 : 260, t + len);
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    src.connect(bp); bp.connect(g); g.connect(this.master); src.start();
  }
  step() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const len = 0.09;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 280;
    const g = this.ctx.createGain(); g.gain.value = 0.12;
    src.connect(lp); lp.connect(g); g.connect(this.master); src.start();
  }
}

// ---------------------------------------------------------------------------
// load

async function load() {
  hud = null;
  setLoading(0.02, '读取工程元数据…');
  const res = await fetch(`./assets/scene.json?v=${ASSET_VERSION}`);
  if (!res.ok) throw new Error(`scene.json ${res.status}`);
  sceneData = await res.json();
  if (sceneData.coordinateSystem !== 'source-z-up-metres-v2') throw new Error('场景资产版本过旧，请重新生成并刷新');
  if (sceneData.nav.navigationVersion !== 3 || sceneData.nav.equipment?.type !== 'bvh-f32-u32-v1') throw new Error('导航资产版本过旧，请重新生成并刷新');
  nav = new NavGrid(sceneData.nav);
  setLoading(0.07, '加载设备碰撞数据…');
  const equipment=sceneData.nav.equipment;
  const equipmentResponse=await fetch(`./assets/${equipment.url}?v=${ASSET_VERSION}`);
  if(!equipmentResponse.ok)throw new Error(`设备碰撞数据加载失败 ${equipmentResponse.status}`);
  const packed=await equipmentResponse.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',packed)),n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==equipment.sha256)throw new Error('设备碰撞数据与当前场景不一致，请重新加载');
  const equipmentBuffer=await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  nav.setEquipment(equipmentBuffer);
  if (typeof nav.floorAtFootprint !== 'function' || !nav.obstacles || !nav.floorOffsets) {
    throw new Error('场景版本不一致，请刷新页面重新加载');
  }
  hud = new HUD(sceneData, nav);
  if (sceneData.freeRoam) hud.setFreeRoam();
  setLoading(0.12, '定位大门与导航网格…');
  player.px = sceneData.start.pos[0];
  player.py = sceneData.start.pos[1];
  player.yaw = THREE.MathUtils.degToRad(sceneData.start.yawDeg);
  player.feet = sceneData.start.floor;
  const safe = nav.floorAt(player.px, player.py, player.feet + 0.8, 0.9);
  if (safe !== null) player.feet = safe;

  setupSky();
  setupEnvironment();

  setLoading(0.18, '加载建筑、设备与场地…');
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('./vendor/jsm/libs/draco/');
  loader.setDRACOLoader(draco);
  let gltf;
  try {
    gltf = await new Promise((resolve, reject) => {
      loader.load(`./assets/world.glb?v=${ASSET_VERSION}`, resolve, (xhr) => {
        if (xhr.total) {
          const p = xhr.loaded / xhr.total;
          setLoading(0.18 + p * 0.68, p < 0.85 ? '解压建筑与设备几何…' : '构建材质与光照…');
        }
      }, reject);
    });
  } finally {
    // This walkthrough loads one complete GLB, with no later streaming decode.
    // Release worker/WASM scratch heaps after their geometry is transferred.
    draco.dispose();
  }

  setLoading(0.9, '整理园区细节…');
  world = gltf.scene;
  scene.add(world);
  let meshCount = 0;
  const modelNodes = [];
  world.traverse((o) => {
    modelNodes.push(o);
    if (!o.isMesh) return;
    meshCount++;
    const name = o.name || '';
    o.castShadow = !(name.startsWith('DOOR_') || name.startsWith('GATE_') || name.startsWith('ROLL_'));
    o.receiveShadow = true;
    o.frustumCulled = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.envMapIntensity = 0.65;
      if (m.transparent) {
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
    }
  });
  setupGround(world);
  addInteriorLights();
  addTrees();
  landmarkGroup = addLandmarkLabels();
  setupFlashlight();

  doors = new DoorManager(world, sceneData);
  prepareStaticModel(world, modelNodes,
    doors.entries.flatMap(entry => entry.leaves.map(leaf => leaf.obj)),
    () => doors.refreshAllTargets());
  doors.onToggle = (entry) => {
    audio?.creak(entry.open);
    const label = entry.isGate ? '大门' : entry.name || '门';
    hud.toast(entry.open ? `已开启：${label}` : `已关闭：${label}`);
  };

  // Place camera at spawn.
  updateCamera(0);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);

  setLoading(1, '准备就绪');
  loaded = true;
  beginSimulation();
  notifyHost('gim-ready',{title:sceneData.title});
  console.log(`scene ready: ${meshCount} meshes, ${sceneData.counts.ifcTriangles + sceneData.counts.gimTriangles} triangles`);
}

// ---------------------------------------------------------------------------
// player / camera

function forwardBlender() {
  return { x: -Math.sin(player.yaw), y: Math.cos(player.yaw) };
}

function applyResolution() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6) * qualityScale);
}

function updateAdaptiveQuality(dt) {
  if (!started || renderPaused || document.hidden) return;
  const fps = hud?.fpsValue || 0;
  if (fps <= 0) return;
  if (fps < 28 && qualityScale > 0.66) {
    lowFpsTime += dt;
    if (lowFpsTime > 2.5) {
      qualityScale = Math.max(0.66, qualityScale - 0.12);
      applyResolution();
      lowFpsTime = 0;
      if (!qualityNotified) {
        qualityNotified = true;
        hud.toast('已自动降低渲染分辨率以保持流畅');
      }
    }
  } else {
    lowFpsTime = 0;
  }
  if (fps > 55 && qualityScale < 1) {
    highFpsTime += dt;
    if (highFpsTime > 8) {
      qualityScale = Math.min(1, qualityScale + 0.05);
      applyResolution();
      highFpsTime = 0;
    }
  } else {
    highFpsTime = 0;
  }
}

function updateCamera(dt) {
  player.bobPhase += dt * (player.moving ? 9.5 : 2.0);
  const bob = player.grounded && player.moving ? Math.sin(player.bobPhase) * 0.025 : 0;
  camera.position.set(player.px, player.feet + player.eye + bob, -player.py);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
}

function floorCandidate(x, y) {
  return nav.floorAtFootprint(x, y, player.feet, 0.56);
}

function canStand(x, y) {
  const f = floorCandidate(x, y);
  const feet = !player.grounded || f === null ? player.feet : Math.max(f, player.feet);
  if (nav.blocked(x, y, 0.27, feet)) return false;
  if (doors.isBlocked(x, y, 0.27, feet)) return false;
  if (f !== null && f > player.feet + 0.56) return false;
  return true;
}

function tryMove(dx, dy) {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  const steps = Math.max(1, Math.ceil(dist / 0.11));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    if (canStand(player.px + sx, player.py + sy)) {
      player.px += sx; player.py += sy;
    } else if (canStand(player.px + sx, player.py)) {
      player.px += sx;
    } else if (canStand(player.px, player.py + sy)) {
      player.py += sy;
    } else {
      break;
    }
  }
}

function updatePlayer(dt) {
  const running = keys['ShiftLeft'] || keys['ShiftRight'];
  const speed = running ? 6.0 : 3.35;
  let ix = 0, iy = 0;
  if (keys['KeyW']) iy += 1;
  if (keys['KeyS']) iy -= 1;
  if (keys['KeyD']) ix += 1;
  if (keys['KeyA']) ix -= 1;
  ix += touchMove.x;
  iy -= touchMove.y;
  const mag = Math.hypot(ix, iy);
  player.moving = mag > 0.05;
  if (player.moving) {
    ix /= Math.max(1, mag);
    iy /= Math.max(1, mag);
    const f = forwardBlender();
    const rx = Math.cos(player.yaw), ry = Math.sin(player.yaw);
    const mx = (f.x * iy + rx * ix) * speed * dt;
    const my = (f.y * iy + ry * ix) * speed * dt;
    tryMove(mx, my);
    if (player.grounded && performance.now() - lastStepTime > (running ? 320 : 470)) {
      lastStepTime = performance.now();
      audio?.step();
    }
  }

  const target = floorCandidate(player.px, player.py);
  if (player.grounded && target !== null && target >= player.feet - 0.56) {
    const diff = target - player.feet;
    if (diff > 0) player.feet += Math.min(diff, dt * 3.4);
    else player.feet += Math.max(diff, -dt * 4.2);
    if (Math.abs(target - player.feet) < 0.004) player.feet = target;
  } else {
    player.grounded = false;
    const previous = player.feet;
    player.vz -= 16 * dt;
    let next = previous + player.vz * dt;
    if (player.vz > 0) {
      const ceiling = nav.layers(player.px, player.py).find(z => z > previous + 1.7 && z <= next + 1.7);
      if (ceiling !== undefined) { next = ceiling - 1.72; player.vz = 0; }
      if (nav.blocked(player.px, player.py, 0.27, next)) { next = previous; player.vz = 0; }
    }
    const floor = nav.floorAtFootprint(player.px, player.py, Math.max(previous, next), 0);
    if (player.vz <= 0 && floor !== null && next <= floor) {
      next = floor; player.vz = 0; player.grounded = true;
    }
    player.feet = next;
    if (player.feet < (sceneData.home || sceneData.start).floor - 40) returnHome();
  }
  updateCamera(dt);
}

function updateInteraction() {
  const f = forwardBlender();
  const near = doors.nearest(player.px, player.py, player.feet, f.x, f.y, 3.8);
  if (near) hud.setPrompt(doors.promptFor(near.entry));
  else hud.setPrompt('');
  return near;
}

function interact() {
  const f = forwardBlender();
  const near = doors.nearest(player.px, player.py, player.feet, f.x, f.y, 3.8);
  if (!near) {
    hud.toast('附近没有可开启的门');
    return;
  }
  doors.toggle(near.entry);
  hud.setPrompt(doors.promptFor(near.entry));
}

// ---------------------------------------------------------------------------
// mission

function updateMission() {
  const me = sceneData.map.mainEntrance;
  if (sceneData.freeRoam || !sceneData.gate || !me) {
    const zone = hud.zoneAt(player.px, player.py, player.feet);
    if (zone.label !== lastZone) {
      lastZone = zone.label;
      if (zone.indoor) hud.toast(`进入 ${zone.label}`);
    }
    player.indoors = zone.indoor;
    return null;
  }
  if (hud.step === 0) {
    const g = sceneData.gate;
    const dGate = Math.hypot(player.px - g.center[0], player.py - g.center[1]);
    const outward=g.outward || (g.axis==='y'?[0,Math.sign((sceneData.home||sceneData.start).pos[1]-g.center[1])]:[1,0]);
    const dx=player.px-g.center[0],dy=player.py-g.center[1];
    const crossed=dx*outward[0]+dy*outward[1]<-.5;
    const along=-dx*outward[1]+dy*outward[0];
    const width=Math.max(g.bbox[3]-g.bbox[0],g.bbox[4]-g.bbox[1]);
    if(crossed && Math.abs(along)<width/2+1 && dGate<8.5)hud.advanceMission(1);
  }
  if (hud.step === 1) {
    if (Math.hypot(player.px - me[0], player.py - me[1]) < 8.2) hud.advanceMission(2);
  }
  if (hud.step === 2) {
    const zone = hud.zoneAt(player.px, player.py, player.feet);
    const entranceWing = sceneData.interiors.find(i => i.id === 'entrance_wing');
    const r = entranceWing.rect;
    if (zone.indoor && player.px > r[0] && player.px < r[2] && player.py > r[1] && player.py < r[3]) hud.advanceMission(3);
  }
  const zone = hud.zoneAt(player.px, player.py, player.feet);
  if (zone.label !== lastZone) {
    lastZone = zone.label;
    if (zone.indoor) hud.toast(`进入 ${zone.label}`);
  }
  player.indoors = zone.indoor;
  return currentWaypoint();
}

function currentWaypoint() {
  if (!hud) return null;
  if (sceneData.freeRoam || !sceneData.map.gate || !sceneData.map.mainEntrance) return null;
  if (hud.step === 0) return sceneData.map.gate;
  if (hud.step === 1 || hud.step === 2) return sceneData.map.mainEntrance;
  return null;
}

// ---------------------------------------------------------------------------
// UI events

function requestLock() {
  if(hostBridge?.isLocked(window,hostSession)){syncPointerLock();return;}
  canvas.focus({ preventScroll: true });
  if (isTouch || nolock) return;
  if (document.pointerLockElement === canvas) return;
  if(hostBridge){
    hostBridge.requestLock(window,hostSession).then(syncPointerLock).catch(()=>hud.toast('按住左键拖动也可环顾'));
    return;
  }
  const fallback = () => {
    if (!controlsActive()) return;
    const hint = () => hud.toast('鼠标未锁定：按住左键拖动也可环顾');
    try {
      const p = canvas.requestPointerLock?.();
      if (p?.catch) p.catch(hint);
      else if (!canvas.requestPointerLock) hint();
    } catch { hint(); }
  };
  try {
    const p = canvas.requestPointerLock?.({ unadjustedMovement: true });
    if (p?.catch) p.catch(fallback);
  } catch { fallback(); }
}

function controlsActive() {
  return started && !controlsPaused && !helpOpen && !mapOpen && !renderPaused && !runtimeFailure;
}

function jump() {
  if (!controlsActive() || !player.grounded) return;
  player.grounded = false;
  player.vz = 5.2;
}

function toggleMap(force) {
  const next = force === undefined ? !mapOpen : force;
  if (!started || next === mapOpen || helpOpen) return;
  if (next) pausedBeforeMap = controlsPaused;
  mapOpen = next;
  clearInput();
  hud.showMap(mapOpen);
  if (mapOpen) {
    releasePointerLock();
    hud.showPause(false);
    const f = forwardBlender();
    hud.drawMinimap(player.px, player.py, f.x, f.y, doors.entries, performance.now(), hud.el.stationMap);
  } else {
    controlsPaused = pausedBeforeMap;
    hud.showPause(controlsPaused);
    if (!controlsPaused) requestLock();
  }
}

function returnHome() {
  if (!started) return;
  const home = sceneData.home || sceneData.start;
  clearInput();
  player.px = home.pos[0]; player.py = home.pos[1];
  player.feet = nav.floorAt(player.px, player.py, home.floor + 0.8, 0.9) ?? home.floor;
  player.yaw = THREE.MathUtils.degToRad(home.yawDeg); player.pitch = 0;
  player.vz = 0; player.grounded = true;
  if (mapOpen) toggleMap(false);
  updateCamera(0);
  hud.toast(sceneData.gate ? '已返回整站大门' : '已返回初始入口');
}

function clearInput() {
  for (const k of Object.keys(keys)) keys[k] = false;
  touchMove.x = touchMove.y = 0;
  dragging = false;
  player.moving = false;
}

function pauseControls() {
  clearInput();
  if (!started || helpOpen || mapOpen) return;
  controlsPaused = true;
  hud.showPause(true);
  if (pointerLocked()) releasePointerLock();
}

function stopForRuntimeError(error) {
  if (runtimeFailure) return;
  runtimeFailure = String(error?.message || error);
  errors.push(runtimeFailure);
  console.error('漫游更新失败', error);
  clearInput();
  controlsPaused = true;
  started = false;
  releasePointerLock();
  if (hud) {
    hud.showHelp(false);
    mapOpen = false;
    hud.showMap(false);
    hud.showPause(true);
    const panel = document.getElementById('pause');
    panel.querySelector('h2').textContent = '漫游已停止';
    panel.querySelector('p').textContent = '运行遇到错误，已释放鼠标。请重新加载场景。';
    document.getElementById('resume-btn').textContent = '重新加载场景';
  }
}

function beginSimulation() {
    if (!loaded || runtimeFailure || started) return;
    started = true;
    controlsPaused = false;
    clearInput();
    audio = new AudioEngine();
    audio.start();
    audio.resume();
    hud.enterTour();
    requestLock();
    if (isTouch) document.getElementById('mobile-controls').classList.remove('hidden');
    else if (!nolock) setTimeout(() => {
      if (!pointerLocked() && !lockEver) hud.toast('鼠标未锁定：按住左键拖动也可环顾');
    }, 700);
    if (sceneData.freeRoam) hud.toast('自由探索：Space 跳跃，M 地图，R 返回入口');
    else if (hud.step === 0) hud.toast('从大门进入变电站，按 E 开启大门');
}

function syncPointerLock(){
    if(!started)return;
    if(pointerLocked()){
      lockEver=true;controlsPaused=false;
      if(!hostBridge?.isLocked(window,hostSession))canvas.focus({preventScroll:true});
      lockYaw=player.yaw;lockPitch=player.pitch;mouseGuardUntil=performance.now()+500;hud.showPause(false);
    }else if(lockEver&&!helpOpen&&!mapOpen&&!isTouch)pauseControls();
}
function applyLook(dx,dy){
    if(!controlsActive() || !Number.isFinite(dx) || !Number.isFinite(dy))return;
    if(performance.now()<mouseGuardUntil)return;
    player.yaw-=dx*.00215;player.pitch-=dy*.00205;
    player.pitch=Math.max(-1.43,Math.min(1.43,player.pitch));
}

function setupUI() {
  if (params.get('catalog') === '1') document.querySelector('.level-back')?.removeAttribute('hidden');

  document.getElementById('resume-btn').addEventListener('click', () => {
    if (runtimeFailure) { location.reload(); return; }
    controlsPaused = false;
    clearInput();
    hud.showPause(false);
    requestLock();
  });
  document.getElementById('help-btn').addEventListener('click', () => toggleHelp());
  document.getElementById('pause-help-btn').addEventListener('click', () => { hud.showPause(false); toggleHelp(true); });
  document.getElementById('help-close').addEventListener('click', () => toggleHelp(false));
  document.getElementById('map-btn').addEventListener('click', () => toggleMap());
  document.getElementById('map-close').addEventListener('click', () => toggleMap(false));
  document.getElementById('home-btn').addEventListener('click', returnHome);
  document.getElementById('map-home').addEventListener('click', returnHome);
  document.getElementById('sound-btn').addEventListener('click', () => {
    if (!audio) audio = new AudioEngine(), audio.start();
    const on = audio.toggleMute();
    document.getElementById('sound-btn').textContent = on ? '♪' : '×';
    hud.toast(on ? '声音已开启' : '声音已静音');
  });
  document.getElementById('fullscreen-btn').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  canvas.addEventListener('click', () => {
    if (controlsActive() && !isTouch && !pointerLocked()) { requestLock();audio?.resume(); }
  });
  document.addEventListener('pointerlockchange', syncPointerLock);
  window.addEventListener('message',event=>{
    const d=event.data;
    if(!hostBridge||event.source!==parent||event.origin!==location.origin||d?.type!=='gim-host'||d.session!==hostSession)return;
    if(d.kind==='lock')syncPointerLock();
    if(d.kind==='look'&&pointerLocked())applyLook(d.dx,d.dy);
    if(d.kind==='key'&&['keydown','keyup'].includes(d.eventType)&&typeof d.code==='string')window.dispatchEvent(new KeyboardEvent(d.eventType,{code:d.code,repeat:!!d.repeat,cancelable:true}));
  });
  document.addEventListener('mousemove', (e) => {
    if (!controlsActive()) return;
    if (pointerLocked()) {
      applyLook(e.movementX,e.movementY);
    } else if (dragging) {
      player.yaw -= (e.clientX - lastPointer.x) * 0.0032;
      player.pitch -= (e.clientY - lastPointer.y) * 0.0030;
      lastPointer = { x: e.clientX, y: e.clientY };
    }
    player.pitch = Math.max(-1.43, Math.min(1.43, player.pitch));
  });
  canvas.addEventListener('mousedown', (e) => {
    if (controlsActive() && !pointerLocked()) {
      dragging = true; lastPointer = { x: e.clientX, y: e.clientY };
    }
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  window.addEventListener('keydown', (e) => {
    if (!started) return;
    const code = e.code;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) e.preventDefault();
    if (code === 'Escape') {
      if (mapOpen) { pausedBeforeMap = true; toggleMap(false); }
      else if (helpOpen) { pausedBeforeHelp = true; toggleHelp(false); }
      else { pauseControls(); releasePointerLock(); }
      return;
    }
    if (e.repeat) return;
    if (code === 'KeyQ' && (hostBridge || document.querySelector('.level-back:not([hidden])'))) {
      clearInput(); releasePointerLock();
      if(hostBridge)notifyHost('gim-exit');else window.location.href = document.querySelector('.level-back').href;
      return;
    }
    if (code === 'KeyM' && !helpOpen) { toggleMap(); return; }
    if ((code === 'KeyR' || code === 'Home') && !helpOpen) { e.preventDefault(); returnHome(); return; }
    if (mapOpen) return;
    if (code === 'KeyH') { toggleHelp(); return; }
    if (!controlsActive()) return;
    if (code === 'Space') { jump(); return; }
    if (code === 'KeyL') {
      if (landmarkGroup) {
        landmarkGroup.visible = !landmarkGroup.visible;
        hud.toast(landmarkGroup.visible ? '地标标签已显示' : '地标标签已隐藏');
      }
      return;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(code)) e.preventDefault();
    keys[code] = true;
    if (code === 'KeyE') interact();
    if (code === 'KeyF') toggleFlashlight();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => {
    if(hostBridge?.isLocked(window,hostSession))clearInput();else pauseControls();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseControls(); });

  // Touch look.
  let lookId = null;
  let lookX = 0, lookY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (!isTouch || !controlsActive()) return;
    lookId = e.pointerId; lookX = e.clientX; lookY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!isTouch || !controlsActive() || e.pointerId !== lookId) return;
    player.yaw -= (e.clientX - lookX) * 0.004;
    player.pitch -= (e.clientY - lookY) * 0.0038;
    player.pitch = Math.max(-1.43, Math.min(1.43, player.pitch));
    lookX = e.clientX; lookY = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => { if (e.pointerId === lookId) lookId = null; });

  // Virtual joystick.
  const joy = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  let joyId = null;
  const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
  joy.addEventListener('pointerdown', (e) => {
    if (!controlsActive()) return;
    joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
  });
  joy.addEventListener('pointermove', (e) => {
    if (!controlsActive() || e.pointerId !== joyId) return;
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = (e.clientX - cx) / (r.width / 2);
    let dy = (e.clientY - cy) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    touchMove.x = dx; touchMove.y = dy;
    setKnob(dx * 30, dy * 30);
  });
  const endJoy = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null; touchMove.x = touchMove.y = 0; setKnob(0, 0);
  };
  joy.addEventListener('pointerup', endJoy);
  joy.addEventListener('pointercancel', endJoy);
  document.getElementById('mobile-interact').addEventListener('click', () => { if (controlsActive()) interact(); });
  document.getElementById('mobile-torch').addEventListener('click', toggleFlashlight);
  document.getElementById('mobile-jump').addEventListener('click', jump);
  document.getElementById('mobile-map').addEventListener('click', () => toggleMap());
}

function toggleHelp(force) {
  const next = force !== undefined ? force : !helpOpen;
  if (next === helpOpen) return;
  if (next) pausedBeforeHelp = controlsPaused;
  helpOpen = next;
  clearInput();
  hud.showHelp(helpOpen);
  if (helpOpen) {
    releasePointerLock();
    hud.showPause(false);
  } else if (started) {
    controlsPaused = pausedBeforeHelp;
    hud.showPause(controlsPaused);
    if (!controlsPaused) requestLock();
  }
}

function toggleFlashlight() {
  flashlightOn = !flashlightOn;
  if (flashlight) flashlight.intensity = flashlightOn ? 85 : 0;
  hud.toast(flashlightOn ? '手电筒已开启' : '手电筒已关闭');
}

// ---------------------------------------------------------------------------
// debug

function setupDebug() {
  window.__tour = {
    get ready() { return loaded; },
    scene, camera, renderer,
    get sceneData() { return sceneData; },
    get nav() { return nav; },
    get doors() { return doors?.getState() || []; },
    get hud() { return hud; },
    state() {
      const f = forwardBlender();
      const zone = hud.zoneAt(player.px, player.py, player.feet);
      return {
        px: player.px, py: player.py, feet: player.feet,
        yaw: player.yaw, pitch: player.pitch,
        fx: f.x, fy: f.y,
        indoor: zone.indoor, label: zone.label,
        step: hud.step, started, helpOpen, mapOpen, controlsPaused, runtimeFailure,
        grounded: player.grounded, verticalVelocity: player.vz,
        pointerLocked: pointerLocked(),
        fps: hud.fpsValue,
        doors: doors.getState(),
        errors,
      };
    },
    teleport(x, y, z) {
      player.px = x; player.py = y;
      const f = z !== undefined ? z : nav.safeFloor(x, y, player.feet);
      player.feet = f;
      player.vz = 0; player.grounded = true;
      updateCamera(0);
    },
    setYaw(deg) { player.yaw = THREE.MathUtils.degToRad(deg); updateCamera(0); },
    setPitch(deg) { player.pitch = THREE.MathUtils.degToRad(deg); updateCamera(0); },
    setStep(n) { hud.setMission(n); },
    toggleDoor(id) {
      const e = doors.entries.find(d => String(d.id) === String(id));
      if (e) { doors.toggle(e); return true; }
      return false;
    },
    openGate() {
      const e = doors.entries.find(d => d.isGate);
      if (e && !e.open) { doors.toggle(e); return true; }
      return false;
    },
    closeAll() {
      for (const e of doors.entries) if (e.open) doors.toggle(e);
    },
    interact,
    setPaused(p) { renderPaused = !!p; },
    renderOnce() {
      updateCamera(0);
      if (hud && started) {
        const f = forwardBlender();
        hud.update({
          px: player.px, py: player.py, feet: player.feet,
          yawDeg: THREE.MathUtils.radToDeg(player.yaw),
          fx: f.x, fy: f.y,
          doors: doors.entries,
          waypoint: currentWaypoint(),
        });
      }
      updateLandmarkLabels();
      renderer.render(scene, camera);
    },
    setFlashlight(on) {
      if (on !== flashlightOn) toggleFlashlight();
    },
  };
}

// ---------------------------------------------------------------------------
// loop

let dust = null;
let dustPositions = null;
let dustTime = 0;

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.25, Math.max(0, (now - clock.last) / 1000));
  clock.last = now;
  if (renderPaused) return;
  try {
    if (started) {
      if (controlsActive()) advancePlayer(dt, updatePlayer);
      else { player.moving = false; updateCamera(0); }
      doors.update(dt);
      const target = updateMission();
      updateInteraction();
      const f = forwardBlender();
      hud.update({
        px: player.px, py: player.py, feet: player.feet,
        yawDeg: THREE.MathUtils.radToDeg(player.yaw),
        fx: f.x, fy: f.y,
        doors: doors.entries,
        waypoint: target,
      });
      if (flashlightOn && flashlight) flashlight.intensity = 85;
      updateLandmarkLabels();
      updateAdaptiveQuality(dt);
    }
    if (dust) {
      dustTime += dt;
      dust.rotation.y = Math.sin(dustTime * 0.03) * 0.02;
      dust.position.y = Math.sin(dustTime * 0.12) * 0.15;
    }
    renderer.render(scene, camera);
  } catch (error) { stopForRuntimeError(error); }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyResolution();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('error', (e) => {
  errors.push(String(e.message || e.error || 'unknown error'));
  console.error('runtime error', e.error || e.message);
});

setupUI();
setupDebug();
animate();

load().then(() => {
  // Add dust after load so it is easy to find the object.
  dust = addDust();
}).catch((e) => {
  releasePointerLock();
  setLoading(0.99);
  fatal(`加载失败：${e.message || e}`);
});
