/* eslint-disable */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const CFG = {
  particles: 4250,
  secondaryParticles: 50000,
  fieldRadius: 90,
  defaultZoom: 88,
  pixelRatio: 1.75,
  sensitivity: 1.1,
  timeScale: 1.311,
  bloom: 0.6074502496953552,
  cameraShake: 2,
  pulseIntensity: 0.15,
  onsetDecay: 0.92,
  connectionThreshold: 5,
  maxFps: 60,
  secondaryAzimuthChunks: 8,
  secondaryVerticalChunks: 3,
  secondaryCullPadding: 20
};

const def = {
  c1: "#00ff88",
  c2: "#00ffcc",
  c3: "#88ffff",
  sc1: "#66ffbb",
  sc2: "#99ffdd",
  s: 3,
  curl: 3,
  sz: 2.6
};

let disposed = false;
let frameId = 0;
const cleanups = [];
const listen = (target, type, handler, options) => {
  if (!target?.addEventListener) return;
  target.addEventListener(type, handler, options);
  cleanups.push(() => target.removeEventListener?.(type, handler, options));
};

const BAND_UNIFORMS = ["uSubBass", "uBass", "uLowMid", "uMid", "uHighMid", "uHigh", "uUltraHigh"];
const SUB_BASS = 0;
const BASS = 1;
const LOW_MID = 2;
const MID = 3;
const HIGH_MID = 4;
const HIGH = 5;
const ULTRA_HIGH = 6;
const clamp = (value) => THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
const uniforms = (values) =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { value }]));
const shaderMaterial = (vertexShader, fragmentShader, values) =>
  new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: uniforms(values),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

const AUDIO = {
  active: false,
  bands: new Float32Array(7),
  previous: new Float32Array(7),
  peaks: new Float32Array(45),
  peakIndex: 0,
  peakCount: 0,
  beatEnergy: 0,
  lastBeatTime: 0,
  spectralCentroid: 0,
  spectralFlux: 0,
  onsetEnergy: 0,

  reset() {
    this.active = false;
    this.bands.fill(0);
    this.previous.fill(0);
    this.peaks.fill(0);
    this.peakIndex = this.peakCount = 0;
    this.beatEnergy = this.onsetEnergy = this.spectralCentroid = this.spectralFlux = 0;
  },

  apply(levels, radioBass, active) {
    if (!active || !Array.isArray(levels) || levels.length < 18) return this.reset();

    const avg = (from, to) => {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += clamp(levels[i]);
      return sum / (to - from + 1);
    };

    const b = this.bands;
    const p = this.previous;
    p.set(b);
    b[SUB_BASS] = avg(0, 1);
    b[BASS] = Math.max(avg(2, 4), clamp(radioBass));
    b[LOW_MID] = avg(5, 6);
    b[MID] = avg(7, 11);
    b[HIGH_MID] = avg(12, 13);
    b[HIGH] = avg(14, 16);
    b[ULTRA_HIGH] = clamp(levels[17]);
    this.active = true;

    let total = 0;
    let weighted = 0;
    let flux = 0;
    for (let i = 0; i < 7; i++) {
      total += b[i];
      weighted += b[i] * i;
      const rise = Math.max(0, b[i] - p[i]);
      flux += rise * rise;
    }
    this.spectralCentroid = total ? weighted / total / 6 : 0;
    this.spectralFlux = Math.sqrt(flux / 7);

    const rise = (i) => Math.max(0, b[i] - p[i]);
    const kick = rise(SUB_BASS) * 0.7 + rise(BASS);
    const clap = rise(LOW_MID) * 0.45 + rise(MID) * 0.7 + rise(HIGH_MID);
    const tick = rise(HIGH_MID) * 0.35 + rise(HIGH) + rise(ULTRA_HIGH) * 0.8;
    const transient =
      Math.max(kick * 4.5, clap * 5.5, tick * 7, this.spectralFlux * 5) * CFG.sensitivity;

    const energy = b[SUB_BASS] * 0.35 + b[BASS] * 0.65;
    this.peaks[this.peakIndex] = energy;
    this.peakIndex = (this.peakIndex + 1) % this.peaks.length;
    this.peakCount = Math.min(this.peakCount + 1, this.peaks.length);

    let mean = 0;
    for (let i = 0; i < this.peakCount; i++) mean += this.peaks[i];
    mean /= this.peakCount;

    let variance = 0;
    for (let i = 0; i < this.peakCount; i++) {
      const d = this.peaks[i] - mean;
      variance += d * d;
    }
    variance /= this.peakCount;

    const adaptiveKick =
      energy > Math.max(0.075, mean + Math.sqrt(variance) * 1.15) && kick > 0.012;
    const hit = transient > 0.08;
    const now = performance.now();
    const cooldown = kick * 4.5 >= Math.max(clap * 5.5, tick * 7) ? 85 : 45;

    if ((adaptiveKick || hit) && now - this.lastBeatTime > cooldown) {
      this.beatEnergy = Math.max(
        this.beatEnergy,
        THREE.MathUtils.clamp(transient * 3.2 + (adaptiveKick ? 0.3 : 0), 0.3, 1)
      );
      this.lastBeatTime = now;
    }

    this.onsetEnergy = hit
      ? Math.max(this.onsetEnergy, THREE.MathUtils.clamp(transient * 3.5, 0.35, 1))
      : this.onsetEnergy * CFG.onsetDecay;
  },

  update() {
    this.beatEnergy *= 0.93;
  }
};

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000508, 0.005);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 800);
camera.position.set(0, 12, CFG.defaultZoom);

const renderer = new THREE.WebGLRenderer({
  powerPreference: "high-performance",
  antialias: false,
  alpha: true
});
renderer.setClearColor(0x000000, 0);
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(CFG.pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 2.1;
[document.documentElement, document.body].forEach((el) =>
  Object.assign(el.style, { margin: 0, width: "100%", height: "100%", overflow: "hidden" })
);
renderer.domElement.style.cssText =
  "position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:1";
document.body.appendChild(renderer.domElement);

const themeBackdrop = document.createElement("div");
themeBackdrop.style.cssText =
  "position:fixed;inset:-4vh -4vw;z-index:0;pointer-events:none;background-position:center;background-size:cover;background-repeat:no-repeat;transform:translate3d(0,0,0) scale(1.055);transform-origin:center;will-change:transform";
document.body.prepend(themeBackdrop);

const cameraTarget = new THREE.Vector3();
camera.lookAt(cameraTarget);

let backdropX = 0;
let backdropY = 0;
let backdropTargetX = 0;
let backdropTargetY = 0;

const updatePointer = (x, y) => {
  backdropTargetX = -THREE.MathUtils.clamp(Number(x) || 0, -1, 1) * 18;
  backdropTargetY = -THREE.MathUtils.clamp(Number(y) || 0, -1, 1) * 12;
};

const noiseShader = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const vertexShader = `
uniform float uTime, uPixelRatio, uSizeBase, uNoiseScale, uCurlStrength, uRadius;
uniform vec3 uColor1, uColor2, uColor3;
uniform float uSubBass, uBass, uLowMid, uMid, uHighMid, uHigh, uUltraHigh;
uniform float uBeatEnergy, uSpectralCentroid, uSpectralFlux;
uniform float uOnsetEnergy;
uniform float uPulseIntensity, uZoomFactor, uAudioActivity;
attribute vec3 aRandom;
attribute float aPhase;
varying vec3 vColor;
varying float vAlpha, vEnergy, vDepth, vRimLight;

${noiseShader}

vec3 curl(float x, float y, float z) {
    float eps = 0.08;
    return vec3(
        snoise(vec3(x, y+eps, z)) - snoise(vec3(x, y-eps, z)),
        snoise(vec3(x, y, z+eps)) - snoise(vec3(x, y, z-eps)),
        snoise(vec3(x+eps, y, z)) - snoise(vec3(x-eps, y, z))
    );
}

void main() {
    float t = uTime * (1.0 + uMid * 0.5);
    vec3 noisePos = position * 0.035 + aRandom;
    vec3 flow1 = curl(noisePos.x * uNoiseScale + t*0.1, noisePos.y * uNoiseScale, noisePos.z * uNoiseScale);
    vec3 flow2 = curl(noisePos.x * uNoiseScale * 2.2 + t*0.07, noisePos.y * uNoiseScale * 2.2 + t*0.08, noisePos.z * uNoiseScale * 2.2) * 0.4;
    vec3 flow3 = curl(noisePos.x * uNoiseScale * 0.5 - t*0.05, noisePos.y * uNoiseScale * 0.5, noisePos.z * uNoiseScale * 0.5) * 0.6 * uLowMid;
    vec3 flow = flow1 + flow2 * uHigh + flow3;

    vec3 newPos = position + (flow * uCurlStrength * (1.0 + uSpectralFlux * 2.5));

    float distToCenter = length(newPos);
    vec3 centerDir = normalize(newPos + vec3(0.001));

    float beatRing = sin(distToCenter * 0.25 - uTime * 6.0) * uBeatEnergy * uPulseIntensity;
    newPos += centerDir * beatRing * 2.0;

    float breathing = sin(uTime * 1.8 + aPhase) * uSubBass * 2.0;
    newPos += centerDir * breathing * exp(-distToCenter * 0.04);

    newPos += centerDir * smoothstep(0.3, 0.8, uBass) * 2.0 * exp(-distToCenter * 0.06);

    float onsetPunch = uOnsetEnergy * 3.0 * exp(-distToCenter * 0.03);
    newPos += centerDir * onsetPunch;

    vec4 mvPosition = modelViewMatrix * vec4(newPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float idleScale = mix(2.0, 1.0, uAudioActivity);
    float size = uSizeBase * 0.35 * idleScale * (0.85 + uBass * 0.18 + uBeatEnergy * 0.22) * (1.0 + (uZoomFactor - 1.0) * 0.3);
    size *= 1.0 + sin(uTime * 10.0 + aPhase * 6.28) * uHigh * 0.35;
    gl_PointSize = clamp(size * uPixelRatio * (90.0 / -mvPosition.z), 0.25, 6.0);

    float colorMix = smoothstep(0.0, 2.8, length(flow) + uHighMid * 3.0);
    vec3 baseColor = mix(uColor1, uColor2, colorMix);
    baseColor = mix(baseColor, uColor3, uSpectralCentroid * uHigh * 2.5);

    float energyLevel = uBeatEnergy * 0.35 + uSpectralFlux * 0.8;
    vColor = mix(baseColor, vec3(1.0), energyLevel * 0.4);
    vColor += vec3(0.08, 0.04, 0.12) * uUltraHigh * 2.5;

    vRimLight = pow(1.0 - max(0.0, dot(normalize(-mvPosition.xyz), normalize(newPos))), 3.0);
    vEnergy = energyLevel;
    vDepth = clamp(-mvPosition.z / 120.0, 0.0, 1.0);

    float alpha = 1.0 - smoothstep(uRadius * 0.7, uRadius, distToCenter);
    float sparkle = 1.0 + (aRandom.x > 0.8 ? sin(uTime * 20.0 + aRandom.y * 150.0) * uHigh * 2.5 : 0.0);
    vAlpha = alpha * sparkle * (0.7 + uMid * 0.35);
}`;

const fragmentShader = `
varying vec3 vColor;
varying float vAlpha, vEnergy, vDepth, vRimLight;

void main() {
    vec2 xy = gl_PointCoord.xy - vec2(0.5);
    float r = length(xy);
    if(r > 0.5) discard;

    float core = smoothstep(0.16 - vEnergy * 0.04, 0.12 - vEnergy * 0.04, r);
    float glow = exp(-r * r * (20.0 - vEnergy * 10.0));
    float halo = exp(-r * r * 5.0) * 0.35 + exp(-r * r * 2.5) * 0.15;

    vec3 finalColor = mix(vColor, vec3(1.0, 0.95, 0.9), core * 0.7);
    finalColor += vec3(0.2, 0.3, 0.4) * vRimLight * 0.3;
    finalColor = mix(finalColor, vec3(0.02, 0.03, 0.05), vDepth * 0.4);

    float finalAlpha = clamp(vAlpha * (glow + halo + pow(1.0 - r * 2.0, 2.5) * 0.6), 0.0, 1.0);
    gl_FragColor = vec4(finalColor, finalAlpha);
}`;

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uBeatEnergy: { value: 0.0 }
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uBeatEnergy;
        varying vec2 vUv;
        void main() {
            vec4 color = texture2D(tDiffuse, vUv);
            vec2 uv = vUv * (1.0 - vUv.yx);
            float vig = pow(uv.x * uv.y * 15.0, 0.38 * (1.0 - uBeatEnergy * 0.15));
            float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
            float glow = smoothstep(0.5, 0.9, lum) * 0.1 * (1.0 + uBeatEnergy * 0.5);
            gl_FragColor = vec4(color.rgb * vig * (1.0 + glow), color.a);
        }`
};

const geometry = new THREE.BufferGeometry();
const pos = new Float32Array(CFG.particles * 3);
const rnd = new Float32Array(CFG.particles * 3);
const phase = new Float32Array(CFG.particles);
const vec = new THREE.Vector3();

for (let i = 0; i < CFG.particles; i++) {
  vec.setFromSphericalCoords(
    CFG.fieldRadius * Math.pow(Math.random(), 0.33),
    Math.acos(2 * Math.random() - 1),
    Math.random() * Math.PI * 2
  );
  const offset = i * 3;
  vec.toArray(pos, offset);
  rnd[offset] = Math.random();
  rnd[offset + 1] = Math.random();
  rnd[offset + 2] = Math.random();
  phase[i] = Math.random() * Math.PI * 2;
}

geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
geometry.setAttribute("aRandom", new THREE.BufferAttribute(rnd, 3));
geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));

const material = shaderMaterial(vertexShader, fragmentShader, {
  uTime: 0,
  uPixelRatio: CFG.pixelRatio,
  uSizeBase: def.sz,
  uNoiseScale: def.s,
  uCurlStrength: def.curl,
  uRadius: CFG.fieldRadius,
  uColor1: new THREE.Color(def.c1),
  uColor2: new THREE.Color(def.c2),
  uColor3: new THREE.Color(def.c3),
  uSubBass: 0,
  uBass: 0,
  uLowMid: 0,
  uMid: 0,
  uHighMid: 0,
  uHigh: 0,
  uUltraHigh: 0,
  uBeatEnergy: 0,
  uSpectralCentroid: 0,
  uSpectralFlux: 0,
  uOnsetEnergy: 0,
  uPulseIntensity: CFG.pulseIntensity,
  uZoomFactor: camera.position.length() / CFG.defaultZoom,
  uAudioActivity: 0
});

const points = new THREE.Points(geometry, material);
scene.add(points);

const secondaryVertexShader = `
uniform float uTime, uPixelRatio;
uniform float uSubBass, uBass, uLowMid, uMid, uHighMid, uHigh, uUltraHigh;
uniform float uBeatEnergy, uSpectralCentroid, uSpectralFlux, uOnsetEnergy;
uniform vec3 uColor1, uColor2;
uniform float uRadius, uAudioActivity;

attribute vec3 aRandom;
attribute float aPhase;

varying vec3 vColor;
varying float vAlpha;
varying float vEnergy;
varying float vDepth;

${noiseShader}

void hideParticle() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vAlpha = 0.0;
    vEnergy = 0.0;
    vDepth = 1.0;
}

void main() {
    // Cheap conservative LOD/culling before the six expensive simplex-noise calls.
    // A wide 2x screen margin prevents visible edge popping from shader displacement.
    vec4 baseView = modelViewMatrix * vec4(position, 1.0);
    vec4 baseClip = projectionMatrix * baseView;
    float baseDepth = -baseView.z;
    if (
        baseView.z > 35.0 ||
        (baseClip.w > 0.0 &&
            (abs(baseClip.x) > baseClip.w * 2.0 || abs(baseClip.y) > baseClip.w * 2.0)) ||
        baseDepth > mix(165.0, 225.0, aRandom.z)
    ) {
        hideParticle();
        return;
    }

    float t = uTime * 0.45;

    vec3 noisePos = position * 0.035 + aRandom;
    vec3 drift = vec3(
        snoise(noisePos + t * 0.06),
        snoise(noisePos * 0.9 - t * 0.05),
        snoise(noisePos * 1.1 + t * 0.04)
    ) * (5.0 + uSubBass * 10.0 + uLowMid * 6.0);

    vec3 turbulence = vec3(
        snoise(noisePos * 2.5 + t * 0.18),
        snoise(noisePos * 2.5 - t * 0.14),
        snoise(noisePos * 2.5 + t * 0.12)
    ) * (uHigh * 5.0 + uSpectralFlux * 8.0);

    vec3 offset = drift + turbulence;

    float orbitSpeed = 0.12 + aRandom.x * 0.15 + uBass * 0.08;
    float angle = uTime * orbitSpeed + aPhase;
    float orbitRadius = length(position.xz) * (1.0 + uSubBass * 0.25);
    vec3 orbit = vec3(
        cos(angle) * orbitRadius - position.x,
        sin(uTime * 0.5 + aPhase) * (uMid * 4.0 + uLowMid * 2.0),
        sin(angle) * orbitRadius - position.z
    ) * 0.07;

    vec3 newPos = position + offset + orbit;

    float dist = length(newPos);
    vec3 dir = normalize(newPos + 0.001);
    newPos += dir * uOnsetEnergy * 14.0 * exp(-dist * 0.025);

    float breathe = sin(uTime * 1.2 + aPhase) * uSubBass * 5.0;
    newPos += dir * breathe * exp(-dist * 0.035);

    vec4 mvPosition = modelViewMatrix * vec4(newPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float sparkle = 1.0 + (aRandom.x > 0.85 ? sin(uTime * 15.0 + aRandom.y * 200.0) * uUltraHigh * 3.0 : 0.0);
    float swell = 1.0 + uSubBass * 0.6 + uLowMid * 0.3;
    float idleScale = mix(2.0, 1.0, uAudioActivity);
    float size = 0.225 * idleScale * (1.1 + uBeatEnergy * 0.25) * swell * sparkle;
    gl_PointSize = clamp(size * uPixelRatio * (55.0 / -mvPosition.z), 0.25, 4.0);

    float centroidMix = clamp(uSpectralCentroid * 2.2 + uHighMid * 0.4, 0.0, 1.0);
    vColor = mix(uColor1, uColor2, centroidMix);
    vColor = mix(vColor, vColor * 1.3, uSubBass * 0.4);
    vColor = mix(vColor, vec3(1.0), uBeatEnergy * 0.25);

    float edgeFade = 1.0 - smoothstep(uRadius * 0.6, uRadius * 1.15, dist);
    vAlpha = edgeFade * (0.45 + uMid * 0.35 + uLowMid * 0.2) * sparkle;

    vEnergy = uBeatEnergy * 0.4 + uHighMid * 0.3 + uOnsetEnergy * 0.3;
    vDepth = clamp(-mvPosition.z / 160.0, 0.0, 1.0);
}
`;

const secondaryFragmentShader = `
varying vec3 vColor;
varying float vAlpha;
varying float vEnergy;
varying float vDepth;

void main() {
    vec2 xy = gl_PointCoord.xy - vec2(0.5);
    float r = length(xy);
    if (r > 0.5) discard;

    float glow     = exp(-r * r * 14.0);
    float softGlow = exp(-r * r * 7.0) * 0.3;
    float core     = smoothstep(0.18 - vEnergy * 0.06, 0.10, r);

    vec3 finalColor = mix(vColor, vec3(1.0, 0.97, 0.92), core * 0.55);
    finalColor = mix(finalColor, vec3(0.02, 0.03, 0.06), vDepth * 0.35);

    float finalAlpha = clamp(vAlpha * (glow * 0.65 + softGlow + core * 0.35), 0.0, 1.0);
    gl_FragColor = vec4(finalColor, finalAlpha);
}
`;

const secondaryMaterial = shaderMaterial(secondaryVertexShader, secondaryFragmentShader, {
  uTime: 0,
  uPixelRatio: CFG.pixelRatio,
  uSubBass: 0,
  uBass: 0,
  uLowMid: 0,
  uMid: 0,
  uHighMid: 0,
  uHigh: 0,
  uUltraHigh: 0,
  uBeatEnergy: 0,
  uSpectralCentroid: 0,
  uSpectralFlux: 0,
  uOnsetEnergy: 0,
  uAudioActivity: 0,
  uColor1: new THREE.Color(def.sc1),
  uColor2: new THREE.Color(def.sc2),
  uRadius: CFG.fieldRadius
});

const secondaryChunkCount = CFG.secondaryAzimuthChunks * CFG.secondaryVerticalChunks;
const secondaryChunks = Array.from({ length: secondaryChunkCount }, () => ({
  position: [],
  random: [],
  phase: []
}));

for (let i = 0; i < CFG.secondaryParticles; i++) {
  const r = CFG.fieldRadius * (0.65 + Math.random() * 0.45);
  const theta = Math.acos(2 * Math.random() - 1);
  const phi = Math.random() * Math.PI * 2;
  const sinTheta = Math.sin(theta);
  const x = r * sinTheta * Math.cos(phi);
  const y = r * sinTheta * Math.sin(phi);
  const z = r * Math.cos(theta);
  const azimuthAngle = (Math.atan2(z, x) + Math.PI * 2) % (Math.PI * 2);
  const azimuth = Math.min(
    CFG.secondaryAzimuthChunks - 1,
    Math.floor((azimuthAngle / (Math.PI * 2)) * CFG.secondaryAzimuthChunks)
  );
  const vertical = Math.min(
    CFG.secondaryVerticalChunks - 1,
    Math.floor((y / r + 1) * 0.5 * CFG.secondaryVerticalChunks)
  );
  const chunk = secondaryChunks[vertical * CFG.secondaryAzimuthChunks + azimuth];

  chunk.position.push(x, y, z);
  chunk.random.push(Math.random(), Math.random(), Math.random());
  chunk.phase.push(Math.random() * Math.PI * 2);
}

const secondaryGroup = new THREE.Group();
for (const chunk of secondaryChunks) {
  if (!chunk.phase.length) continue;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(chunk.position, 3));
  geometry.setAttribute("aRandom", new THREE.Float32BufferAttribute(chunk.random, 3));
  geometry.setAttribute("aPhase", new THREE.Float32BufferAttribute(chunk.phase, 1));
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius += CFG.secondaryCullPadding;

  const cloud = new THREE.Points(geometry, secondaryMaterial);
  cloud.frustumCulled = true;
  secondaryGroup.add(cloud);
}
scene.add(secondaryGroup);

class TrailSystem {
  constructor(count, length) {
    this.length = length;
    this.trails = Array.from({ length: count }, () => {
      const history = new Float32Array(length * 3);
      for (let i = 0; i < history.length; i++) history[i] = (Math.random() - 0.5) * 80;
      return {
        history,
        color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6),
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.7
      };
    });

    const segments = count * (length - 1);
    this.positions = new Float32Array(segments * 6);
    this.colors = new Float32Array(segments * 6);
    this.alphas = new Float32Array(segments * 2);
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", this.position);
    this.geometry.setAttribute("color", this.color);
    this.geometry.setAttribute("alpha", this.alpha);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 130);

    const material = shaderMaterial(
      `attribute float alpha; attribute vec3 color; varying float vAlpha; varying vec3 vColor;
       void main() {
         vAlpha = alpha;
         vColor = color;
         gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
       }`,
      `varying float vAlpha; varying vec3 vColor;
       void main() { gl_FragColor = vec4(vColor, clamp(vAlpha, 0.0, 0.82)); }`,
      {}
    );

    this.mesh = new THREE.LineSegments(this.geometry, material);
    scene.add(this.mesh);
  }

  update(time, bass, mid, high, highMid, beat, onset, fieldColor) {
    const impact = Math.max(beat, onset, highMid * 0.72, high * 0.58);
    const alphaScale = 0.28 + beat * 0.22;
    let segment = 0;

    for (const trail of this.trails) {
      const p = trail.history;
      const angle = time * 0.5 * trail.speed + trail.phase;
      const radius = 30 + bass * 20;
      let x =
        Math.cos(angle) * radius + Math.sin(time * trail.speed + trail.phase) * (10 + bass * 15);
      let y =
        Math.sin(time * 0.3 + trail.phase) * 20 +
        Math.cos(time * trail.speed * 0.7 + trail.phase) * (8 + mid * 12);
      let z =
        Math.sin(angle) * radius +
        Math.sin(time * trail.speed * 0.5 + trail.phase * 2) * (10 + high * 10);

      const last = p.length - 3;
      const dx = x - p[last];
      const dy = y - p[last + 1];
      const dz = z - p[last + 2];
      const longness = THREE.MathUtils.smoothstep(Math.hypot(dx, dy, dz), 18, 48);
      const scale = 1 + longness * impact * 0.12;
      x *= scale;
      y *= scale;
      z *= scale;

      p.copyWithin(3, 0, last);
      p[0] = x;
      p[1] = y;
      p[2] = z;
      trail.color.lerp(fieldColor, 0.01);

      const hit = longness * impact;
      const brightness = 0.76 + beat * 0.28 + hit * 1.15;
      const r = Math.min(trail.color.r * brightness, 1.35);
      const g = Math.min(trail.color.g * brightness, 1.35);
      const b = Math.min(trail.color.b * brightness, 1.35);
      const trailAlpha = alphaScale + hit * 0.72;

      for (let i = 0; i < this.length - 1; i++, segment++) {
        const a = i * 3;
        const c = a + 3;
        const out = segment * 6;
        const alphaOut = segment * 2;

        this.positions[out] = p[a];
        this.positions[out + 1] = p[a + 1];
        this.positions[out + 2] = p[a + 2];
        this.positions[out + 3] = p[c];
        this.positions[out + 4] = p[c + 1];
        this.positions[out + 5] = p[c + 2];

        this.colors[out] = this.colors[out + 3] = r;
        this.colors[out + 1] = this.colors[out + 4] = g;
        this.colors[out + 2] = this.colors[out + 5] = b;
        this.alphas[alphaOut] = (1 - i / this.length) * trailAlpha;
        this.alphas[alphaOut + 1] = (1 - (i + 1) / this.length) * trailAlpha;
      }
    }

    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

const trailSystem = new TrailSystem(50, 12);

const CONNECTION_COUNT = 500;
const MAX_CONNECTIONS = 800;
const NETWORK_REFRESH = 40;
const MAX_NETWORK_DISTANCE = CFG.connectionThreshold * 2.5;
const trackedPos = new Float32Array(CONNECTION_COUNT * 3);
const trackedRadius = new Float32Array(CONNECTION_COUNT);
const maxPairs = (CONNECTION_COUNT * (CONNECTION_COUNT - 1)) / 2;
const pairA = new Uint16Array(maxPairs);
const pairB = new Uint16Array(maxPairs);
const pairDistance = new Float32Array(maxPairs);
const pairCenter = new Float32Array(maxPairs);
let pairCount = 0;
let networkFrame = 0;
let refreshFrame = 0;

const connectionGeometry = new THREE.BufferGeometry();
const connectionPositions = new Float32Array(MAX_CONNECTIONS * 6);
const connectionAlphas = new Float32Array(MAX_CONNECTIONS * 2);
connectionGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(connectionPositions, 3).setUsage(THREE.DynamicDrawUsage)
);
connectionGeometry.setAttribute(
  "alpha",
  new THREE.BufferAttribute(connectionAlphas, 1).setUsage(THREE.DynamicDrawUsage)
);

const connectionMaterial = shaderMaterial(
  `attribute float alpha; varying float vAlpha, vDist; void main() {
    vAlpha = alpha;
    vDist = length(position) / 90.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`,
  `uniform vec3 uColor, uColor2;
   uniform float uBeatEnergy, uOnsetEnergy, uBass, uHighMid, uSpectralCentroid;
   varying float vAlpha, vDist;
   void main() {
     vec3 color = mix(uColor, uColor2, clamp(uSpectralCentroid * 2.0, 0.0, 1.0));
     float bass = smoothstep(0.06, 0.65, uBass);
     float hit = max(uBeatEnergy, uOnsetEnergy);
     color = min(color * (1.0 + (1.0 - vDist) * 0.6) *
       (0.72 + bass * 0.35 + uHighMid * 0.2 + uBeatEnergy * 0.65 + uOnsetEnergy * 0.55), vec3(1.35));
     gl_FragColor = vec4(color, clamp(vAlpha * (0.18 + uHighMid * 0.3 + bass * 0.35 + hit * 0.55), 0.0, 0.72));
   }`,
  {
    uColor: new THREE.Color(def.c2),
    uColor2: new THREE.Color(def.c1),
    uBeatEnergy: 0,
    uOnsetEnergy: 0,
    uBass: 0,
    uHighMid: 0,
    uSpectralCentroid: 0
  }
);
const connectionMesh = new THREE.LineSegments(connectionGeometry, connectionMaterial);
scene.add(connectionMesh);

function refreshNetwork() {
  const source = geometry.attributes.position.array;
  const maxDistanceSq = MAX_NETWORK_DISTANCE ** 2;

  for (let i = 0; i < CONNECTION_COUNT; i++) {
    const sourceOffset = Math.floor(Math.random() * CFG.particles) * 3;
    const offset = i * 3;
    trackedPos[offset] = source[sourceOffset];
    trackedPos[offset + 1] = source[sourceOffset + 1];
    trackedPos[offset + 2] = source[sourceOffset + 2];
    trackedRadius[i] = Math.hypot(
      trackedPos[offset],
      trackedPos[offset + 1],
      trackedPos[offset + 2]
    );
  }

  pairCount = 0;
  for (let i = 0; i < CONNECTION_COUNT; i++) {
    const ai = i * 3;
    const ax = trackedPos[ai];
    const ay = trackedPos[ai + 1];
    const az = trackedPos[ai + 2];

    for (let j = i + 1; j < CONNECTION_COUNT; j++) {
      const bj = j * 3;
      const dx = ax - trackedPos[bj];
      const dy = ay - trackedPos[bj + 1];
      const dz = az - trackedPos[bj + 2];
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq >= maxDistanceSq || distanceSq <= 0.1) continue;

      pairA[pairCount] = i;
      pairB[pairCount] = j;
      pairDistance[pairCount] = Math.sqrt(distanceSq);
      pairCenter[pairCount] =
        1 - Math.min((trackedRadius[i] + trackedRadius[j]) / (CFG.fieldRadius * 2), 1);
      pairCount++;
    }
  }
}

function updateConnections(bass, highMid, mid) {
  if (++networkFrame % 3) return;
  if (++refreshFrame >= NETWORK_REFRESH) {
    refreshFrame = 0;
    refreshNetwork();
  }

  const threshold = CFG.connectionThreshold * (1 + bass * 1.4) * (1 - highMid * 0.08);
  const limit = Math.floor(
    MAX_CONNECTIONS * Math.min(1, 0.22 + bass * 0.55 + mid * 0.45 + highMid * 0.65)
  );

  let count = 0;
  for (let p = 0; p < pairCount && count < limit; p++) {
    const distance = pairDistance[p];
    if (distance >= threshold) continue;

    const a = pairA[p] * 3;
    const b = pairB[p] * 3;
    const out = count * 6;
    connectionPositions[out] = trackedPos[a];
    connectionPositions[out + 1] = trackedPos[a + 1];
    connectionPositions[out + 2] = trackedPos[a + 2];
    connectionPositions[out + 3] = trackedPos[b];
    connectionPositions[out + 4] = trackedPos[b + 1];
    connectionPositions[out + 5] = trackedPos[b + 2];

    const alpha = (1 - distance / threshold) * (0.6 + pairCenter[p] * 0.4);
    connectionAlphas[count * 2] = alpha;
    connectionAlphas[count * 2 + 1] = alpha;
    count++;
  }

  connectionGeometry.attributes.position.needsUpdate = true;
  connectionGeometry.attributes.alpha.needsUpdate = true;
  connectionGeometry.setDrawRange(0, count * 2);
}

refreshNetwork();

const CRAWLER_COUNT = 24;
const CRAWLER_TAIL = 10;
const CRAWLER_MIN_STEP_SQ = 1.8 ** 2;
const crawlerMaxSegments = CRAWLER_COUNT * (CRAWLER_TAIL - 1);
const crawlerGeometry = new THREE.BufferGeometry();
const crawlerPositions = new Float32Array(crawlerMaxSegments * 6);
const crawlerAlphas = new Float32Array(crawlerMaxSegments * 2);
crawlerGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(crawlerPositions, 3).setUsage(THREE.DynamicDrawUsage)
);
crawlerGeometry.setAttribute(
  "alpha",
  new THREE.BufferAttribute(crawlerAlphas, 1).setUsage(THREE.DynamicDrawUsage)
);

const crawlerMaterial = shaderMaterial(
  `attribute float alpha; varying float vAlpha; void main() {
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`,
  `uniform vec3 uColor; uniform float uBeatEnergy; varying float vAlpha; void main() {
    gl_FragColor = vec4(min(uColor * (0.82 + uBeatEnergy * 0.72), vec3(1.25)), min(vAlpha, 0.72));
  }`,
  { uColor: new THREE.Color(def.c1), uBeatEnergy: 0 }
);
const crawlerMesh = new THREE.LineSegments(crawlerGeometry, crawlerMaterial);
scene.add(crawlerMesh);

const crawlers = Array.from({ length: CRAWLER_COUNT }, () => ({
  from: Math.floor(Math.random() * CONNECTION_COUNT),
  to: Math.floor(Math.random() * CONNECTION_COUNT),
  t: Math.random(),
  speed: 0.0015 + Math.random() * 0.002,
  tail: new Float32Array(CRAWLER_TAIL * 3),
  length: 0,
  lastX: NaN,
  lastY: NaN,
  lastZ: NaN
}));

function nearestNeighbour(from, exclude, highMid) {
  const origin = from * 3;
  const ox = trackedPos[origin];
  const oy = trackedPos[origin + 1];
  const oz = trackedPos[origin + 2];
  const thresholdSq = (CFG.connectionThreshold * (1.2 + highMid * 0.4)) ** 2;
  const checks = 80;
  const start = Math.floor(Math.random() * (CONNECTION_COUNT - checks));
  let best = -1;
  let bestDistance = Infinity;

  for (let n = 0; n < checks; n++) {
    const candidate = (start + n) % CONNECTION_COUNT;
    if (candidate === from || candidate === exclude) continue;
    const p = candidate * 3;
    const dx = ox - trackedPos[p];
    const dy = oy - trackedPos[p + 1];
    const dz = oz - trackedPos[p + 2];
    const distance = dx * dx + dy * dy + dz * dz;
    if (distance < thresholdSq && distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best < 0 ? Math.floor(Math.random() * CONNECTION_COUNT) : best;
}

function updateCrawlers(highMid, beat, centroid, frameScale = 1) {
  let segment = 0;

  for (const crawler of crawlers) {
    crawler.t += crawler.speed * frameScale * (1 + highMid * 0.8 + beat * 0.5);

    if (crawler.t >= 1) {
      crawler.t -= 1;
      crawler.from = crawler.to;
      crawler.to = nearestNeighbour(crawler.from, crawler.from, highMid);

      if (Math.random() < 0.04) {
        crawler.from = Math.floor(Math.random() * CONNECTION_COUNT);
        crawler.to = nearestNeighbour(crawler.from, crawler.from, highMid);
        crawler.length = 0;
        crawler.lastX = crawler.lastY = crawler.lastZ = NaN;
      }
    }

    const a = crawler.from * 3;
    const b = crawler.to * 3;
    let x = trackedPos[a] + (trackedPos[b] - trackedPos[a]) * crawler.t;
    let y = trackedPos[a + 1] + (trackedPos[b + 1] - trackedPos[a + 1]) * crawler.t;
    let z = trackedPos[a + 2] + (trackedPos[b + 2] - trackedPos[a + 2]) * crawler.t;
    const radius = Math.hypot(x, y, z);
    if (radius > CFG.fieldRadius) {
      const scale = CFG.fieldRadius / radius;
      x *= scale;
      y *= scale;
      z *= scale;
    }

    const dx = x - crawler.lastX;
    const dy = y - crawler.lastY;
    const dz = z - crawler.lastZ;
    if (
      crawler.length === 0 ||
      !Number.isFinite(dx) ||
      dx * dx + dy * dy + dz * dz >= CRAWLER_MIN_STEP_SQ
    ) {
      const tail = crawler.tail;
      if (crawler.length < CRAWLER_TAIL) {
        const offset = crawler.length++ * 3;
        tail[offset] = x;
        tail[offset + 1] = y;
        tail[offset + 2] = z;
      } else {
        tail.copyWithin(0, 3);
        const offset = tail.length - 3;
        tail[offset] = x;
        tail[offset + 1] = y;
        tail[offset + 2] = z;
      }
      crawler.lastX = x;
      crawler.lastY = y;
      crawler.lastZ = z;
    }

    const tail = crawler.tail;
    for (let i = 0; i < crawler.length - 1 && segment < crawlerMaxSegments; i++) {
      const from = i * 3;
      const to = from + 3;
      const out = segment * 6;
      crawlerPositions[out] = tail[from];
      crawlerPositions[out + 1] = tail[from + 1];
      crawlerPositions[out + 2] = tail[from + 2];
      crawlerPositions[out + 3] = tail[to];
      crawlerPositions[out + 4] = tail[to + 1];
      crawlerPositions[out + 5] = tail[to + 2];

      const alpha = ((i + 1) / (crawler.length - 1)) * (0.25 + centroid * 0.3 + beat * 0.4);
      crawlerAlphas[segment * 2] = alpha;
      crawlerAlphas[segment * 2 + 1] = alpha;
      segment++;
    }
  }

  crawlerGeometry.attributes.position.needsUpdate = true;
  crawlerGeometry.attributes.alpha.needsUpdate = true;
  crawlerGeometry.setDrawRange(0, segment * 2);
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 1.5, 0.4, 0.85);
bloomPass.threshold = 0.3;
bloomPass.strength = CFG.bloom;
bloomPass.radius = 0.22;
composer.addPass(bloomPass);

const vignettePass = new ShaderPass(VignetteShader);
composer.addPass(vignettePass);
composer.addPass(new OutputPass());

composer.addPass(
  new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
    fragmentShader: `uniform sampler2D tDiffuse;
                varying vec2 vUv;
                 void main() {
                     vec4 color = texture2D(tDiffuse, vUv);
                     vec3 detailLift = pow(max(color.rgb, vec3(0.0)), vec3(0.82)) * 1.2;
                     float visibleLight = max(detailLift.r, max(detailLift.g, detailLift.b));
                     float overlayAlpha = clamp(visibleLight * 1.35, 0.0, 1.0);
                     gl_FragColor = vec4(detailLift, overlayAlpha);
                 }`
  })
);

let themeDirty = true;
let targetPalette = {
  c1: new THREE.Color(def.c1),
  c2: new THREE.Color(def.c2),
  c3: new THREE.Color(def.c3),
  sc1: new THREE.Color(def.sc1),
  sc2: new THREE.Color(def.sc2)
};

const renderColor = (value, light) => {
  if (!light) return value;
  const match = /^#([0-9a-f]{6})$/i.exec(value?.trim?.() || "");
  if (!match) return value;
  return `#${[0, 2, 4]
    .map((i) => (255 - parseInt(match[1].slice(i, i + 2), 16)).toString(16).padStart(2, "0"))
    .join("")}`;
};

const applyTheme = (data) => {
  const palette = data.palette;
  if (
    !palette ||
    !["primary", "primaryHover", "secondary", "accent", "highlight"].every(
      (key) => typeof palette[key] === "string"
    )
  )
    return;

  const backgroundColor = typeof data.backgroundColor === "string" ? data.backgroundColor : "#000";
  const backgroundImage = typeof data.backgroundImage === "string" ? data.backgroundImage : "none";
  [document.documentElement, document.body, themeBackdrop].forEach(
    (el) => (el.style.backgroundColor = backgroundColor)
  );
  themeBackdrop.style.backgroundImage = backgroundImage;

  const light = data.theme === "light";
  targetPalette = {
    c1: new THREE.Color(renderColor(palette.primary, light)),
    c2: new THREE.Color(renderColor(palette.accent, light)),
    c3: new THREE.Color(renderColor(palette.highlight, light)),
    sc1: new THREE.Color(renderColor(palette.primaryHover, light)),
    sc2: new THREE.Color(renderColor(palette.secondary, light))
  };
  themeDirty = true;
};

const parentMessages = {
  QFT_AUDIO: ({ bands, bass, active }) => AUDIO.apply(bands, bass, active),
  QFT_POINTER: ({ x, y }) => updatePointer(x, y),
  QFT_THEME: applyTheme,
  QFT_DISPOSE: () => dispose()
};

listen(window, "message", ({ source, data = {} }) => {
  if (source === window.parent) parentMessages[data.type]?.(data);
});
window.parent.postMessage({ type: "QFT_READY" }, "*");

const clock = new THREE.Timer();
clock.connect(document);

const u = material.uniforms;
const su = secondaryMaterial.uniforms;
const cu = connectionMaterial.uniforms;
const cr = crawlerMaterial.uniforms;
const bandTargets = BAND_UNIFORMS.map((name) => u[name]);
const secondaryCopies = [
  "uTime",
  ...BAND_UNIFORMS,
  "uBeatEnergy",
  "uSpectralCentroid",
  "uSpectralFlux",
  "uOnsetEnergy",
  "uAudioActivity"
].map((name) => [su[name], u[name]]);
const connectionCopies = [
  "uBeatEnergy",
  "uOnsetEnergy",
  "uBass",
  "uHighMid",
  "uSpectralCentroid"
].map((name) => [cu[name], u[name]]);
const cameraBase = new THREE.Vector3();
const crawlerColor = new THREE.Color();
const frameInterval = 1000 / CFG.maxFps;
let lastRender = 0;
let crawlerFrame = 0;
const lerpUniform = (uniform, value, alpha = 0.16) =>
  (uniform.value = THREE.MathUtils.lerp(uniform.value, value, alpha));

function animate(timestamp) {
  if (disposed) return;
  frameId = requestAnimationFrame(animate);
  if (document.hidden || (lastRender && timestamp - lastRender < frameInterval - 1)) return;
  lastRender = timestamp;
  clock.update(timestamp);

  const dt = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.getElapsed();

  const backdropDx = backdropTargetX - backdropX;
  const backdropDy = backdropTargetY - backdropY;
  if (Math.abs(backdropDx) > 0.01 || Math.abs(backdropDy) > 0.01) {
    backdropX += backdropDx * 0.085;
    backdropY += backdropDy * 0.085;
    themeBackdrop.style.transform = `translate3d(${backdropX.toFixed(2)}px,${backdropY.toFixed(2)}px,0) scale(1.055)`;
  }

  u.uTime.value += dt * CFG.timeScale;
  const audioActivity = +AUDIO.active;
  lerpUniform(u.uAudioActivity, audioActivity, 0.08);
  AUDIO.update();

  for (let i = 0; i < BAND_UNIFORMS.length; i++) {
    lerpUniform(bandTargets[i], AUDIO.bands[i] * CFG.sensitivity);
  }
  lerpUniform(u.uBeatEnergy, AUDIO.beatEnergy, 0.22);
  lerpUniform(u.uSpectralCentroid, AUDIO.spectralCentroid);
  lerpUniform(u.uSpectralFlux, AUDIO.spectralFlux * CFG.sensitivity);
  lerpUniform(u.uOnsetEnergy, AUDIO.onsetEnergy, 0.25);

  if (themeDirty) {
    u.uColor1.value.lerp(targetPalette.c1, 0.05);
    u.uColor2.value.lerp(targetPalette.c2, 0.05);
    u.uColor3.value.lerp(targetPalette.c3, 0.05);
    su.uColor1.value.lerp(targetPalette.sc1, 0.05);
    su.uColor2.value.lerp(targetPalette.sc2, 0.05);
    cu.uColor.value.lerp(targetPalette.c2, 0.05);
    cu.uColor2.value.lerp(targetPalette.c1, 0.05);

    const closeColor = (a, b) =>
      Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 0.003;

    if (
      closeColor(u.uColor1.value, targetPalette.c1) &&
      closeColor(u.uColor2.value, targetPalette.c2) &&
      closeColor(u.uColor3.value, targetPalette.c3) &&
      closeColor(su.uColor1.value, targetPalette.sc1) &&
      closeColor(su.uColor2.value, targetPalette.sc2)
    )
      themeDirty = false;
  }

  for (const [to, from] of secondaryCopies) to.value = from.value;

  updateConnections(u.uBass.value, u.uHighMid.value, u.uMid.value);
  for (const [to, from] of connectionCopies) to.value = from.value;

  crawlerMesh.visible = AUDIO.active;
  if (crawlerMesh.visible) {
    if (!(crawlerFrame++ & 1))
      updateCrawlers(u.uHighMid.value, u.uBeatEnergy.value, u.uSpectralCentroid.value, 2);
    crawlerColor.lerpColors(u.uColor1.value, u.uColor3.value, u.uSpectralCentroid.value);
    cr.uColor.value.lerp(crawlerColor, 0.05);
    cr.uBeatEnergy.value = u.uBeatEnergy.value;
  }

  vignettePass.uniforms.uBeatEnergy.value = u.uBeatEnergy.value;
  trailSystem.update(
    elapsed,
    u.uBass.value,
    u.uMid.value,
    u.uHigh.value,
    u.uHighMid.value,
    u.uBeatEnergy.value,
    u.uOnsetEnergy.value,
    u.uColor1.value
  );

  const rotateSpeed = 0.35 + u.uMid.value * 0.8 + u.uBeatEnergy.value * 0.8;
  camera.position.applyAxisAngle(THREE.Object3D.DEFAULT_UP, (Math.PI / 30) * rotateSpeed * dt);
  camera.lookAt(cameraTarget);
  cameraBase.copy(camera.position);

  if (CFG.cameraShake > 0 && AUDIO.beatEnergy > 0.1) {
    const shake = AUDIO.beatEnergy * CFG.cameraShake;
    camera.position.set(
      cameraBase.x + (Math.random() - 0.5) * shake * 0.6,
      cameraBase.y + (Math.random() - 0.5) * shake * 0.4,
      cameraBase.z + (Math.random() - 0.5) * shake * 0.25
    );
  }

  const bloomBase = CFG.bloom * (audioActivity ? 0.55 : 1);
  bloomPass.strength = bloomBase + (AUDIO.bands[BASS] + AUDIO.bands[MID] + AUDIO.beatEnergy) / 24;
  renderer.toneMappingExposure = THREE.MathUtils.lerp(
    renderer.toneMappingExposure,
    audioActivity ? 1.55 : 2.1,
    0.06
  );

  composer.render();
  camera.position.copy(cameraBase);
}

listen(document, "visibilitychange", () => {
  if (!document.hidden) lastRender = 0;
});

listen(window, "resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

function dispose() {
  if (disposed) return;
  disposed = true;
  cancelAnimationFrame(frameId);
  cleanups.splice(0).forEach((remove) => remove());
  clock.disconnect?.();
  const disposedMaterials = new Set();
  scene.traverse((object) => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.filter(Boolean).forEach((material) => {
      if (disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      Object.values(material).forEach((value) => value?.isTexture && value.dispose?.());
      material.dispose?.();
    });
  });
  composer.dispose?.();
  renderer.dispose?.();
  renderer.forceContextLoss?.();
  renderer.domElement.remove();
  themeBackdrop.remove();
  window.parent.postMessage({ type: "QFT_DISPOSED" }, "*");
}

window.__QFT_DISPOSE__ = dispose;
listen(window, "pagehide", dispose, { once: true });
listen(window, "beforeunload", dispose, { once: true });
animate();
