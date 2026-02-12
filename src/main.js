import * as THREE from 'https://esm.sh/three@0.161.0';
import { Sky } from 'https://esm.sh/three@0.161.0/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'https://esm.sh/three@0.161.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://esm.sh/three@0.161.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://esm.sh/three@0.161.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SSAOPass } from 'https://esm.sh/three@0.161.0/examples/jsm/postprocessing/SSAOPass.js';
import { BokehPass } from 'https://esm.sh/three@0.161.0/examples/jsm/postprocessing/BokehPass.js';
import * as CANNON from 'https://esm.sh/cannon-es@0.20.0';
import { Client } from 'https://esm.sh/colyseus.js@0.15.14';

const canvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');

let gameStarted = false;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xd49a5f, 0.009);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);

const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.allowSleep = true;

const hemi = new THREE.HemisphereLight(0xffd29a, 0x513016, 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1db, 2.5);
sun.position.set(30, 42, -18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// Physically inspired sky (Takram-atmos style approximation using Perez sky).
const sky = new Sky();
sky.scale.setScalar(300);
scene.add(sky);
const skyUniforms = sky.material.uniforms;
skyUniforms['turbidity'].value = 8;
skyUniforms['rayleigh'].value = 2;
skyUniforms['mieCoefficient'].value = 0.007;
skyUniforms['mieDirectionalG'].value = 0.93;
const sunVec = new THREE.Vector3();
const phi = THREE.MathUtils.degToRad(78);
const theta = THREE.MathUtils.degToRad(110);
sunVec.setFromSphericalCoords(1, phi, theta);
skyUniforms['sunPosition'].value.copy(sunVec);

const roadMat = new THREE.MeshPhysicalMaterial({
  color: 0x2e2a29,
  roughness: 0.75,
  metalness: 0.05,
  clearcoat: 0.1,
  iridescence: 0.15,
  sheen: 0.1,
});

const sandMat = new THREE.MeshPhysicalMaterial({
  color: 0xca9052,
  roughness: 1,
  metalness: 0,
  transmission: 0,
  sheen: 0.24,
});

const road = new THREE.Mesh(new THREE.PlaneGeometry(16, 800), roadMat);
road.rotation.x = -Math.PI / 2;
road.receiveShadow = true;
scene.add(road);

const sand = new THREE.Mesh(new THREE.PlaneGeometry(220, 900), sandMat);
sand.rotation.x = -Math.PI / 2;
sand.position.y = -0.02;
sand.receiveShadow = true;
scene.add(sand);

// Instanced mesa rocks.
const rockGeometry = new THREE.CylinderGeometry(0.8, 1.8, 3, 6, 1);
const rockMat = new THREE.MeshPhysicalMaterial({ color: 0x8c4d2d, roughness: 0.95, metalness: 0.02 });
const rocks = new THREE.InstancedMesh(rockGeometry, rockMat, 250);
const tempMatrix = new THREE.Matrix4();
for (let i = 0; i < 250; i++) {
  const side = i % 2 === 0 ? -1 : 1;
  const x = side * (12 + Math.random() * 70);
  const z = -380 + i * 3.2;
  tempMatrix.compose(
    new THREE.Vector3(x, 1.2, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.random() * Math.PI, 0)),
    new THREE.Vector3(1 + Math.random() * 5, 1 + Math.random() * 10, 1 + Math.random() * 4),
  );
  rocks.setMatrixAt(i, tempMatrix);
}
rocks.castShadow = true;
rocks.receiveShadow = true;
scene.add(rocks);

const rigGroup = new THREE.Group();
scene.add(rigGroup);
const rigBody = new CANNON.Body({ mass: 2500, shape: new CANNON.Box(new CANNON.Vec3(1.6, 0.5, 4.5)) });
rigBody.position.set(0, 1.2, 30);
rigBody.linearDamping = 0.22;
rigBody.angularDamping = 0.45;
world.addBody(rigBody);

const cab = new THREE.Mesh(
  new THREE.BoxGeometry(2.7, 1.7, 6.8),
  new THREE.MeshPhysicalMaterial({ color: 0x5f6a72, metalness: 0.7, roughness: 0.4, anisotropy: 0.6 }),
);
cab.castShadow = true;
rigGroup.add(cab);
const deck = new THREE.Mesh(
  new THREE.BoxGeometry(2.4, 0.3, 3.6),
  new THREE.MeshStandardMaterial({ color: 0x9f9b8d, metalness: 0.4, roughness: 0.65 }),
);
deck.position.set(0, 1.05, 0.4);
rigGroup.add(deck);

const pursuers = [];
const projectiles = [];
const debris = [];

const groundBody = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
world.addBody(groundBody);

function spawnPursuer(x = (Math.random() - 0.5) * 10, z = rigBody.position.z - 80) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 1, 3.3),
    new THREE.MeshPhysicalMaterial({ color: 0x7f2716, roughness: 0.45, metalness: 0.78, clearcoat: 0.2 }),
  );
  shell.castShadow = true;
  g.add(shell);
  scene.add(g);

  const body = new CANNON.Body({ mass: 1300, shape: new CANNON.Box(new CANNON.Vec3(1.1, 0.5, 1.7)) });
  body.position.set(x, 1.1, z);
  body.linearDamping = 0.18;
  world.addBody(body);
  pursuers.push({ g, body, hp: 3 });
}

for (let i = 0; i < 10; i++) spawnPursuer((Math.random() - 0.5) * 12, rigBody.position.z - 35 - i * 28);

const keys = {};
window.addEventListener('keydown', (e) => (keys[e.code] = true));
window.addEventListener('keyup', (e) => (keys[e.code] = false));
window.addEventListener('mousedown', fireProjectile);

function fireProjectile() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffc95f }),
  );
  scene.add(mesh);
  const body = new CANNON.Body({ mass: 0.3, shape: new CANNON.Sphere(0.11) });
  const front = new THREE.Vector3(0, 0.25, -1).applyQuaternion(rigGroup.quaternion).normalize();
  body.position.set(rigBody.position.x, 2, rigBody.position.z - 1.5);
  body.velocity.set(front.x * 95, front.y * 95, front.z * 95 + rigBody.velocity.z);
  body.collisionResponse = true;
  world.addBody(body);
  projectiles.push({ mesh, body, ttl: 2.5 });
}

function explode(pos) {
  for (let i = 0; i < 18; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), new THREE.MeshStandardMaterial({ color: 0xff7332 }));
    scene.add(m);
    const b = new CANNON.Body({ mass: 1, shape: new CANNON.Box(new CANNON.Vec3(0.12, 0.12, 0.12)) });
    b.position.set(pos.x, pos.y, pos.z);
    b.velocity.set((Math.random() - 0.5) * 24, Math.random() * 15, (Math.random() - 0.5) * 24);
    world.addBody(b);
    debris.push({ m, b, ttl: 2 + Math.random() * 2 });
  }
}

function createAudio() {
  const listener = new THREE.AudioListener();
  camera.add(listener);
  const music = new THREE.Audio(listener);
  const ctx = listener.context;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.value = 73;
  gain.gain.value = 0.007;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  music.setNodeSource(gain);

  const engine = new THREE.PositionalAudio(listener);
  const engOsc = ctx.createOscillator();
  const engGain = ctx.createGain();
  engOsc.type = 'square';
  engOsc.frequency.value = 44;
  engGain.gain.value = 0.01;
  engOsc.connect(engGain).connect(ctx.destination);
  engOsc.start();
  engine.setNodeSource(engGain);
  rigGroup.add(engine);
}

let audioBooted = false;
function bootAudioOnce() {
  if (audioBooted) return;
  createAudio();
  audioBooted = true;
}

// Colyseus networking (non-fatal fallback when no server).
async function initNet() {
  statusEl.textContent = 'Trying to connect to Colyseus (2s timeout)...';
  try {
    const client = new Client('ws://localhost:2567');
    const room = await Promise.race([
      client.joinOrCreate('mad-rig'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Colyseus timeout')), 2000)),
    ]);
    statusEl.textContent = `Net: connected (${room.id})`;
    room.onMessage('spawn', ({ x, z }) => spawnPursuer(x, z));
    setInterval(() => {
      room.send('state', { x: rigBody.position.x, z: rigBody.position.z, vx: rigBody.velocity.x, vz: rigBody.velocity.z });
    }, 120);
  } catch {
    statusEl.textContent = 'Net: offline demo mode active. Press Start Run to play now.';
  }
}
initNet();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.9, 0.65, 0.75);
composer.addPass(bloom);
const ssao = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
ssao.kernelRadius = 14;
composer.addPass(ssao);
composer.addPass(new BokehPass(scene, camera, { focus: 35, aperture: 0.00015, maxblur: 0.008 }));

const clock = new THREE.Clock();

function updateRig(dt) {
  const accel = keys['Space'] ? 32 : 18;
  rigBody.velocity.z -= accel * dt;
  if (keys['KeyA']) rigBody.velocity.x -= 16 * dt;
  if (keys['KeyD']) rigBody.velocity.x += 16 * dt;
  if (keys['KeyW']) rigBody.velocity.z -= 8 * dt;
  if (keys['KeyS']) rigBody.velocity.z += 14 * dt;

  rigBody.position.x = THREE.MathUtils.clamp(rigBody.position.x, -6, 6);
  rigBody.position.y = 1.2;
}

function tick() {
  if (!gameStarted) {
    composer.render();
    requestAnimationFrame(tick);
    return;
  }

  const dt = Math.min(clock.getDelta(), 1 / 30);
  updateRig(dt);

  pursuers.forEach((p) => {
    const steer = (rigBody.position.x - p.body.position.x) * 0.7;
    p.body.velocity.x += steer * dt;
    p.body.velocity.z += (rigBody.position.z - 15 - p.body.position.z) * 0.5 * dt;
  });

  projectiles.forEach((b) => (b.ttl -= dt));
  debris.forEach((d) => (d.ttl -= dt));

  world.step(1 / 60, dt, 3);

  rigGroup.position.copy(rigBody.position);
  rigGroup.quaternion.copy(rigBody.quaternion);

  pursuers.forEach((p) => {
    p.g.position.copy(p.body.position);
    p.g.quaternion.copy(p.body.quaternion);
    if (p.body.position.z > rigBody.position.z + 30) {
      p.body.position.z = rigBody.position.z - 120 - Math.random() * 40;
      p.hp = 3;
    }
  });

  projectiles.forEach((p, pi) => {
    p.mesh.position.copy(p.body.position);
    if (p.ttl <= 0) {
      world.removeBody(p.body);
      scene.remove(p.mesh);
      projectiles.splice(pi, 1);
      return;
    }
    pursuers.forEach((e) => {
      if (p.body.position.distanceTo(e.body.position) < 1.4) {
        e.hp -= 1;
        p.ttl = 0;
        if (e.hp <= 0) {
          explode(e.body.position);
          e.body.position.set((Math.random() - 0.5) * 10, 1.1, rigBody.position.z - 120 - Math.random() * 40);
          e.body.velocity.set(0, 0, 0);
          e.hp = 3;
        }
      }
    });
  });

  debris.forEach((d, i) => {
    d.m.position.copy(d.b.position);
    d.m.quaternion.copy(d.b.quaternion);
    if (d.ttl <= 0) {
      world.removeBody(d.b);
      scene.remove(d.m);
      debris.splice(i, 1);
    }
  });

  // Infinite-scrolling road.
  road.position.z = rigBody.position.z - 170;
  sand.position.z = rigBody.position.z - 170;
  for (let i = 0; i < rocks.count; i++) {
    rocks.getMatrixAt(i, tempMatrix);
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    tempMatrix.decompose(pos, q, s);
    if (pos.z > rigBody.position.z + 60) {
      pos.z -= 740;
      tempMatrix.compose(pos, q, s);
      rocks.setMatrixAt(i, tempMatrix);
      rocks.instanceMatrix.needsUpdate = true;
    }
  }

  camera.position.lerp(new THREE.Vector3(rigBody.position.x * 0.55, 4.3, rigBody.position.z + 9), 0.08);
  camera.lookAt(rigBody.position.x * 0.35, 1.7, rigBody.position.z - 17);

  composer.render();
  requestAnimationFrame(tick);
}
tick();

startBtn.addEventListener('click', () => {
  gameStarted = true;
  startBtn.disabled = true;
  startBtn.textContent = 'Running';
  bootAudioOnce();
  if (statusEl.textContent.startsWith('Trying to connect')) {
    statusEl.textContent = 'Net: starting local solo mode while network resolves...';
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});
