import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }  from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader }  from 'three/examples/jsm/loaders/RGBELoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FilmPass } from 'three/examples/jsm/postprocessing/FilmPass.js';

const canvas = document.getElementById('c');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
// Transparent background: leave scene background null

// Camera
const camera = new THREE.PerspectiveCamera(45, window.innerWidth/window.innerHeight, 0.1, 200);
camera.position.set(0.8, 0.6, 1.6);

// Controls for 360° view
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.35, 0);
controls.minDistance = 0.6;
controls.maxDistance = 3.0;

// Lighting
const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 0.85);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
keyLight.position.set(2, 2, 1);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
scene.add(keyLight);

// Ground shadow catcher (optional subtle contact)
const groundGeo = new THREE.PlaneGeometry(6, 6);
const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.rotation.x = -Math.PI/2;
ground.position.y = -0.0;
ground.receiveShadow = true;
scene.add(ground);

// Post-processing
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.0, 0.8, 0.85);
composer.addPass(bloom);
const film = new FilmPass(0.15, 0.2, 648, false);
film.enabled = false;
composer.addPass(film);

// Environment (optional HDR)
let pmrem;
const rgbe = new RGBELoader();
pmrem = new THREE.PMREMGenerator(renderer);
let envMap = null;
try {
  rgbe.load('assets/env.hdr', (hdr) => {
    envMap = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = envMap;
  });
} catch (e) {
  // if missing HDR, proceed without
}

// Load Cat
const loader = new GLTFLoader();
let cat, mixer;
let morphIndexMap = {}; // name -> index
let eyes = null;
let tailBone = null;

// Fur shells
const SHELL_COUNT = 18; // increase for denser fur
const furGroup = new THREE.Group();
let baseCatMesh = null;

function createFurShells(baseMesh, furTexture) {
  const shells = new THREE.Group();
  const geo = baseMesh.geometry.clone();
  geo.computeVertexNormals();
  const matBase = baseMesh.material.clone();
  // Custom shader material for fur shell
  const furMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLayer: { value: 0 },
      uTotalLayers: { value: SHELL_COUNT },
      uFurTex: { value: furTexture },
      uWindDir: { value: new THREE.Vector2(0.4, 0.2) },
      uStrength: { value: 0.006 },
      uColorTint: { value: new THREE.Color('#ffd54f') } // yellow cat
    },
    vertexShader: `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uLayer;
      uniform float uTotalLayers;
      uniform vec2 uWindDir;
      uniform float uStrength;

      void main() {
        vUv = uv;
        float layer = uLayer / uTotalLayers;
        // Normal offset for shell extrusion
        vec3 n = normalize(normal);
        vec3 pos = position + n * layer * 0.02;
        // Subtle wind sway
        float sway = sin(uTime * 1.3 + pos.x * 5.0 + pos.y * 4.5) * 0.2 + cos(uTime * 0.9 + pos.z * 5.5) * 0.2;
        pos += vec3(uWindDir, 0.0) * sway * uStrength * (0.3 + layer);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D uFurTex;
      uniform float uLayer;
      uniform float uTotalLayers;
      uniform vec3 uColorTint;

      void main() {
        vec4 fur = texture2D(uFurTex, vUv * 4.0); // tile a bit
        // Fade tips and base for transparency softness
        float layer = uLayer / uTotalLayers;
        float alpha = fur.a * smoothstep(0.05, 1.0, fur.r) * (1.0 - layer * 0.85);
        vec3 col = mix(vec3(1.0), uColorTint, 0.65) * (0.7 + fur.r * 0.6);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  for (let i=0; i<SHELL_COUNT; i++) {
    const m = new THREE.Mesh(geo, furMat.clone());
    m.material.uniforms.uLayer.value = i+1;
    m.castShadow = false;
    m.receiveShadow = false;
    shells.add(m);
  }
  return shells;
}

const texLoader = new THREE.TextureLoader();
const furTex = texLoader.load('assets/fur.png');
furTex.colorSpace = THREE.SRGBColorSpace;

loader.load('assets/cat.glb', (gltf) => {
  cat = gltf.scene;
  cat.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      // identify base mesh to clone geometry for fur shells
      if (!baseCatMesh) baseCatMesh = o;
      // find eyes mesh by name hint
      if (/eye/i.test(o.name)) eyes = o;
      // collect morph target indices
      if (o.morphTargetDictionary) {
        Object.assign(morphIndexMap, o.morphTargetDictionary);
      }
    }
    if (o.isBone && /tail/i.test(o.name)) {
      tailBone = o;
    }
  });

  // color base coat slightly yellow
  cat.traverse((o) => {
    if (o.isMesh && o.material && o.material.color) {
      o.material.color = new THREE.Color('#ffe066');
      o.material.roughness = 0.6;
      o.material.metalness = 0.0;
    }
  });

  // Fur shells added atop the main visible mesh
  if (baseCatMesh) {
    const shells = createFurShells(baseCatMesh, furTex);
    // Hide base mesh slightly or keep it—adjust opacity for depth
    baseCatMesh.material.transparent = true;
    baseCatMesh.material.opacity = 0.95;
    baseCatMesh.parent.add(shells);
  }

  // Scale/position
  cat.scale.set(0.8, 0.8, 0.8);
  cat.position.set(0, 0, 0);
  scene.add(cat);

  // Animations mixer
  mixer = new THREE.AnimationMixer(cat);
  // If your GLB contains idle animation, play it:
  if (gltf.animations && gltf.animations.length) {
    const idle = gltf.animations.find(a => /idle/i.test(a.name)) || gltf.animations[0];
    mixer.clipAction(idle).play();
  }

}, undefined, (err) => {
  console.warn('Could not load cat.glb, using placeholder.');
  // Placeholder: sphere body
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 48, 48),
    new THREE.MeshStandardMaterial({ color: '#ffe066', roughness: 0.6 })
  );
  baseCatMesh = body;
  const shells = createFurShells(baseCatMesh, furTex);
  const grp = new THREE.Group();
  grp.add(body);
  grp.add(shells);
  grp.position.y = 0.35;
  cat = grp;
  scene.add(cat);
});

// Expression state controller
const expressions = {
  laugh: { key: 'Q', morph: 'laugh', intensity: 1.0, duration: 0.8 },
  cry: { key: 'W', morph: 'cry', intensity: 1.0, duration: 1.2 },
  smile: { key: 'E', morph: 'smile', intensity: 0.9, duration: 1.0 },
  angry: { key: 'R', morph: 'angry', intensity: 1.0, duration: 0.9 },
  surprised: { key: 'T', morph: 'surprised', intensity: 1.0, duration: 0.6 },
  sleepy: { key: 'Y', morph: 'sleepy', intensity: 0.8, duration: 1.4 }
};

const keyMap = {};
Object.values(expressions).forEach(e => keyMap[e.key.toLowerCase()] = e);

function setMorphTarget(mesh, morphName, value) {
  if (!mesh.morphTargetInfluences || !mesh.morphTargetDictionary) return;
  const idx = mesh.morphTargetDictionary[morphName];
  if (idx !== undefined) {
    mesh.morphTargetInfluences[idx] = value;
  }
}

function triggerExpression(name) {
  if (!cat) return;
  const cfg = expressions[name];
  if (!cfg) return;

  // Traverse all meshes to set morph targets where present
  const start = performance.now();
  let t = 0;
  const dur = cfg.duration * 1000;

  function step() {
    const now = performance.now();
    t = (now - start) / dur;
    const upPhase = Math.min(1.0, t * 2.0);
    const downPhase = Math.max(0.0, (t - 0.5) * 2.0);
    const up = THREE.MathUtils.smootherstep(upPhase, 0, 1);
    const down = THREE.MathUtils.smootherstep(downPhase, 0, 1);
    const val = cfg.intensity * (up * (1.0 - down));
    cat.traverse((o) => setMorphTarget(o, cfg.morph, val));

    if (t < 1.0) {
      requestAnimationFrame(step);
    } else {
      // Reset to 0
      cat.traverse((o) => setMorphTarget(o, cfg.morph, 0));
    }
  }
  step();

  // Extra motion: ear twitch / tail swish if bone exists
  if (tailBone) {
    const baseRotZ = tailBone.rotation.z;
    let k = 0;
    const tailStart = performance.now();
    (function tailAnim() {
      const tt = (performance.now() - tailStart) / 600;
      tailBone.rotation.z = baseRotZ + Math.sin(tt * Math.PI * 2) * 0.25 * (1.0 - Math.min(1, tt));
      if (tt < 1) requestAnimationFrame(tailAnim);
      else tailBone.rotation.z = baseRotZ;
    })();
  }
}

// Keyboard
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (keyMap[k]) triggerExpression(Object.keys(expressions).find(n => expressions[n].key.toLowerCase() === k));
});

// Horror mode
let horrific = false;
const btn = document.getElementById('horrorToggle');

function setHorror(on) {
  horrific = on;
  btn.textContent = `Horror: ${on ? 'ON' : 'OFF'}`;

  if (on) {
    // Lighting changes
    hemi.intensity = 0.35;
    hemi.color.set(0x555577);
    keyLight.intensity = 2.0;
    keyLight.color.set(0xff3a2a);
    renderer.toneMappingExposure = 1.2;

    // Eye glow
    if (eyes) {
      eyes.material.emissive = new THREE.Color(0xff2222);
      eyes.material.emissiveIntensity = 2.0;
    }

    // Post-process
    bloom.strength = 0.8;
    film.enabled = true;

  } else {
    hemi.intensity = 0.85;
    hemi.color.set(0xffffff);
    keyLight.intensity = 1.1;
    keyLight.color.set(0xffffff);
    renderer.toneMappingExposure = 1.0;

    if (eyes) {
      eyes.material.emissive = new THREE.Color(0x000000);
      eyes.material.emissiveIntensity = 0.0;
    }

    bloom.strength = 0.0;
    film.enabled = false;
  }
}
btn.addEventListener('click', () => setHorror(!horrific));

// Subtle camera idle bob and horror jitter
let clock = new THREE.Clock();
function animate() {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;

  if (mixer) mixer.update(dt);

  controls.update();

  // Fur shader time
  furGroup.traverse((o) => {
    if (o.isMesh && o.material && o.material.uniforms && o.material.uniforms.uTime) {
      o.material.uniforms.uTime.value = t;
    }
  });

  // Camera idle motion
  const bob = Math.sin(t * 0.5) * 0.01;
  camera.position.y += bob * 0.05;
  if (horrific) {
    camera.rotation.z = Math.sin(t * 13.0) * 0.004;
  } else {
    camera.rotation.z = 0;
  }

  composer.render();
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// Resize
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});
