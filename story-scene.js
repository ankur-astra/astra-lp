/**
 * story-scene.js
 * Scroll-driven 3D story for Astra's security / pentesting landing page.
 *
 * The page owns all text. This file owns only the 3D.
 *
 * Story
 *   calm     clear glass crystal with 10 faint red flaws inside
 *   recon    scan rings sweep, the flaws get labels
 *   breach   a glowing fracture spreads from the weak spot, then the crystal shatters
 *            into glass shards and the camera flies in among the red flaws
 *   freeze   every shard stops in mid-air; scrolling orbits the frozen scene
 *   pentest  each flaw is found, then fixed: red turns green
 *   fix      the shards fly back and lock into place as blue Astra glass
 *   cta      whole blue crystal with green (fixed) flaws inside
 *
 * Page contract
 *   #scene            fixed, full-viewport container behind the content (pointer-events: none)
 *   [data-chapter]    sections named calm | recon | breach | freeze | pentest | fix | cta
 *   #domain-input     optional text input; its value labels the 3D crystal
 *   [data-domain]     optional elements whose text is replaced with the sanitized domain
 *
 * Events (on window)
 *   storyscene:chapter   detail: { chapter }            fired when a chapter becomes active
 *   storyscene:progress  detail: { chapter, progress }  fired while a chapter scrubs (0..1)
 *
 * Usage
 *   import { initStoryScene, destroyStoryScene } from './story-scene.js';
 *   initStoryScene();            // waits for window load by itself
 *   initStoryScene({ labelFont: 'Inter, sans-serif' }); // optional: force a font for the 3D labels
 *   destroyStoryScene();         // disposes everything (call on unmount)
 */

import * as THREE from 'three';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

const CHAPTERS = ['calm', 'recon', 'breach', 'freeze', 'pentest', 'fix', 'cta'];
const SCRUBBED = ['recon', 'breach', 'freeze', 'pentest', 'fix', 'cta'];

const PALETTE = {
  clear: '#e6edfb', // untinted glass
  blue: '#3076f8', // Astra blue glass
  attack: '#ff4b3e', // flaws, cracks
  fixed: '#2fd27a', // fixed flaws
  white: '#e9eefc',
};

const ENDPOINTS = [
  { recon: '443/tcp  nginx 1.18', cvss: 7.5 },
  { recon: '/api/v1/users', cvss: 9.1 },
  { recon: '22/tcp  OpenSSH 7.4', cvss: 5.3 },
  { recon: '/graphql', cvss: 8.2 },
  { recon: 's3://prod-backups', cvss: 9.8 },
  { recon: '/admin/login', cvss: 7.2 },
  { recon: 'jwt  alg=none', cvss: 9.1 },
  { recon: '/.git/config', cvss: 7.5 },
  { recon: '8080/tcp  jenkins', cvss: 8.8 },
  { recon: '/upload?file=', cvss: 9.8 },
];
const IMPACT_ENDPOINT = 1; // the fracture starts at /api/v1/users

const BADGES = ['SOC 2', 'ISO 27001', 'HIPAA', 'GDPR'];
const DEFAULT_DOMAIN = 'yourapp.com';
// The 3D labels use the page's own font (detected at start-up), so they match the site.
let labelFont = 'system-ui, sans-serif';

function detectFont() {
  const el = document.querySelector('[data-chapter]') || document.body;
  const family = el ? window.getComputedStyle(el).fontFamily : '';
  return family && family.trim() ? family : 'system-ui, sans-serif';
}
const CRYSTAL_DETAIL = 2; // icosahedron detail: 2 = 320 shards

let ctx = null;
let pendingLoad = null;

/* ---------- small helpers ---------- */

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitizeDomain(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, 48);
  return v || DEFAULT_DOMAIN;
}

/* ---------- canvas textures ---------- */

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/**
 * A text label drawn on a canvas. style: 'outline' | 'solid' | 'plain'.
 */
function createLabel(text, { style = 'outline', color = '#ffffff', height = 0.16 } = {}) {
  const canvas = document.createElement('canvas');
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: 0,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 6;
  const label = { sprite, canvas, tex, text, style, color, height };
  drawLabel(label);
  return label;
}

function drawLabel(label) {
  const { canvas, style, color } = label;
  const g = canvas.getContext('2d');
  const fontPx = 40;
  const padX = style === 'plain' ? 6 : 26;
  g.font = `500 ${fontPx}px ${labelFont}`;
  const w = Math.ceil(g.measureText(label.text).width) + padX * 2;
  const h = 72;
  canvas.width = Math.max(64, w);
  canvas.height = h;
  g.font = `500 ${fontPx}px ${labelFont}`;
  g.textBaseline = 'middle';
  g.clearRect(0, 0, canvas.width, h);
  if (style !== 'plain') {
    const r = 14;
    g.beginPath();
    g.moveTo(r + 2, 2);
    g.arcTo(canvas.width - 2, 2, canvas.width - 2, h - 2, r);
    g.arcTo(canvas.width - 2, h - 2, 2, h - 2, r);
    g.arcTo(2, h - 2, 2, 2, r);
    g.arcTo(2, 2, canvas.width - 2, 2, r);
    g.closePath();
    if (style === 'solid') {
      g.fillStyle = color;
      g.fill();
    } else {
      g.fillStyle = 'rgba(34, 34, 34, 0.82)';
      g.fill();
      g.lineWidth = 3;
      g.strokeStyle = color;
      g.stroke();
    }
  }
  g.fillStyle = style === 'outline' ? color : style === 'solid' ? '#0d2a12' : '#ffffff';
  g.fillText(label.text, padX, h / 2 + 2);
  label.tex.needsUpdate = true;
  label.sprite.scale.set((label.height * canvas.width) / h, label.height, 1);
}

/* ---------- shard geometry ---------- */

/**
 * Splits an icosahedron into wedge-shaped shards: each outer face plus three
 * side faces running to a point inside the crystal. Every vertex carries its
 * shard's centroid, scatter target, tumble axis and timing so the vertex
 * shader can fly the shard out and back.
 */
function buildShardGeometry(radius, rand, impactDir) {
  const base = new THREE.IcosahedronGeometry(radius, CRYSTAL_DETAIL);
  const src = base.attributes.position;
  const faceCount = src.count / 3;

  const positions = [];
  const centroids = [];
  const targets = [];
  const axes = [];
  const timing = [];
  const barys = [];
  const outer = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const BARY = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let f = 0; f < faceCount; f++) {
    a.fromBufferAttribute(src, f * 3);
    b.fromBufferAttribute(src, f * 3 + 1);
    c.fromBufferAttribute(src, f * 3 + 2);
    const face = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    const inner = face.clone().multiplyScalar(0.72);
    const centroid = new THREE.Vector3().add(a).add(b).add(c).add(inner).multiplyScalar(0.25);
    const dir = centroid.clone().normalize();

    // Scatter target: outward from the crystal, spread wide across the screen.
    const spread = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(1.1);
    const outDir = dir.clone().add(spread).normalize();
    const dist = 2.3 + Math.pow(rand(), 0.7) * 5.6;
    const target = outDir.multiplyScalar(dist);
    target.y *= 0.62;
    target.z = Math.min(2.2, Math.max(-4.5, target.z * 0.7 - 0.5));

    const axis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    // Shards nearest the weak spot break first.
    const delay = clamp01((1 - dir.dot(impactDir)) * 0.5 + (rand() - 0.5) * 0.15);
    const spinAmt = (0.5 + rand() * 1.4) * (rand() < 0.5 ? -1 : 1);

    const tris = [
      [a, b, c],
      [b, a, inner],
      [c, b, inner],
      [a, c, inner],
    ];
    tris.forEach((tri, ti) => {
      tri.forEach((v, k) => {
        outer.push(ti === 0 ? 1 : 0);
        positions.push(v.x, v.y, v.z);
        centroids.push(centroid.x, centroid.y, centroid.z);
        targets.push(target.x, target.y, target.z);
        axes.push(axis.x, axis.y, axis.z);
        timing.push(delay, spinAmt);
        barys.push(...BARY[k]);
      });
    });
  }
  base.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aCentroid', new THREE.Float32BufferAttribute(centroids, 3));
  geo.setAttribute('aTarget', new THREE.Float32BufferAttribute(targets, 3));
  geo.setAttribute('aAxis', new THREE.Float32BufferAttribute(axes, 3));
  geo.setAttribute('aTiming', new THREE.Float32BufferAttribute(timing, 2));
  geo.setAttribute('aBary', new THREE.Float32BufferAttribute(barys, 3));
  geo.setAttribute('aOuter', new THREE.Float32BufferAttribute(outer, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
  return geo;
}

/* ---------- crack geometry ---------- */

/**
 * Builds a branching fracture that radiates from the impact point: jagged,
 * straight-edged segments that zigzag across the facets, with side branches.
 * Each branch becomes a flat ribbon lying on the crystal's faces, carrying
 * aAlong (distance from the impact, 0..1) and aAcross (-1..1 across the ribbon)
 * so the shader can grow it, taper it and give it a glowing gradient.
 */
function buildCrackGeometry(radius, rand, impactDir, mainBranches) {
  const ico = new THREE.IcosahedronGeometry(radius, CRYSTAL_DETAIL);
  const src = ico.attributes.position;
  const tris = [];
  for (let f = 0; f < src.count / 3; f++) {
    const a = new THREE.Vector3().fromBufferAttribute(src, f * 3);
    const b = new THREE.Vector3().fromBufferAttribute(src, f * 3 + 1);
    const c = new THREE.Vector3().fromBufferAttribute(src, f * 3 + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.dot(a) < 0) n.negate();
    tris.push({ a, b, c, n });
  }
  ico.dispose();

  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3());
  const hit = new THREE.Vector3();
  const toSurface = (dir) => {
    ray.direction.copy(dir).normalize();
    for (const tri of tris) {
      if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit)) return { p: hit.clone(), n: tri.n };
    }
    return { p: dir.clone().normalize().multiplyScalar(radius), n: dir.clone().normalize() };
  };

  const branches = [];
  const grow = (start, heading, steps, startAlong, depth) => {
    const dirs = [start.clone()];
    const alongs = [startAlong];
    let p = start.clone();
    const h = heading.clone();
    let along = startAlong;
    let zig = rand() < 0.5 ? 1 : -1;
    for (let s = 0; s < steps; s++) {
      h.applyAxisAngle(p, zig * (0.25 + rand() * 0.35)).projectOnPlane(p).normalize();
      zig *= -1;
      const len = 0.06 + rand() * 0.08;
      p = p.clone().addScaledVector(h, len).normalize();
      along += len;
      dirs.push(p.clone());
      alongs.push(along);
      if (depth < 2 && s > 0 && rand() < 0.3) {
        const bh = h.clone().applyAxisAngle(p, (rand() < 0.5 ? 1 : -1) * (0.5 + rand() * 0.6));
        grow(p, bh, 2 + Math.floor(rand() * 4), along, depth + 1);
      }
    }
    branches.push({ dirs, alongs, depth });
  };

  const t0 = new THREE.Vector3(0, 1, 0).cross(impactDir);
  if (t0.lengthSq() < 1e-4) t0.set(1, 0, 0);
  t0.normalize();
  for (let i = 0; i < mainBranches; i++) {
    const heading = t0.clone().applyAxisAngle(impactDir, (i / mainBranches) * Math.PI * 2 + (rand() - 0.5) * 0.5);
    grow(impactDir.clone().normalize(), heading, 7 + Math.floor(rand() * 7), 0, 0);
  }

  const maxAlong = Math.max(...branches.map((b) => b.alongs[b.alongs.length - 1]));
  const positions = [];
  const alongAttr = [];
  const acrossAttr = [];
  const indices = [];
  const side = new THREE.Vector3();
  const tangent = new THREE.Vector3();

  branches.forEach(({ dirs, alongs, depth }) => {
    const surf = dirs.map(toSurface);
    const base = positions.length / 3;
    surf.forEach((sp, i) => {
      const prev = surf[Math.max(0, i - 1)].p;
      const next = surf[Math.min(surf.length - 1, i + 1)].p;
      tangent.subVectors(next, prev).normalize();
      side.crossVectors(sp.n, tangent).normalize();
      const along = alongs[i] / maxAlong;
      const width = 0.075 * Math.pow(0.6, depth) * (1 - 0.6 * along);
      const lifted = sp.p.clone().addScaledVector(sp.n, 0.012);
      [-1, 1].forEach((sgn) => {
        const v = lifted.clone().addScaledVector(side, width * sgn);
        positions.push(v.x, v.y, v.z);
        alongAttr.push(along);
        acrossAttr.push(sgn);
      });
      if (i > 0) {
        const a = base + (i - 1) * 2;
        const b = base + i * 2;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    });
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(alongAttr, 1));
  geo.setAttribute('aAcross', new THREE.Float32BufferAttribute(acrossAttr, 1));
  geo.setIndex(indices);
  const impact = toSurface(impactDir);
  return { geometry: geo, impactPoint: impact.p.clone().addScaledVector(impact.n, 0.02) };
}

/* ---------- shaders ---------- */

const CRACK_VERT = /* glsl */ `
  attribute float aAlong;
  attribute float aAcross;
  varying float vAlong;
  varying float vAcross;
  void main() {
    vAlong = aAlong;
    vAcross = aAcross;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CRACK_FRAG = /* glsl */ `
  uniform float uGrow;
  uniform float uOpacity;
  uniform float uTime;
  uniform vec3 uHot;
  uniform vec3 uRed;
  uniform vec3 uDeep;
  varying float vAlong;
  varying float vAcross;

  void main() {
    if (vAlong > uGrow) discard;
    float a = abs(vAcross);
    float core = exp(-a * a * 26.0);
    float glow = exp(-a * a * 3.0) * 0.5;

    // Gradient along the fracture: white-hot at the impact, red, then deep red at the tips.
    vec3 col = mix(uHot, uRed, smoothstep(0.0, 0.3, vAlong));
    col = mix(col, uDeep, smoothstep(0.55, 1.0, vAlong));

    // The leading edge burns brighter while the crack is still spreading.
    float tip = 1.0 - smoothstep(0.0, 0.07, uGrow - vAlong);
    float flicker = 0.85 + 0.15 * sin(uTime * 13.0 + vAlong * 40.0);
    vec3 c = col * (core * 1.5 + glow) * flicker + uHot * tip * (core + glow * 0.6) * 1.4;
    gl_FragColor = vec4(c * uOpacity, 1.0);
  }
`;

const ORB_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

// A glowing round flaw: hot white-ish center, saturated body, softly lit rim.
const ORB_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float lightUp = clamp(dot(n, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0);
    vec3 col = uColor * (0.55 + 0.6 * pow(ndv, 1.5));
    col += mix(uColor, vec3(1.0), 0.6) * pow(ndv, 6.0) * 0.55;
    col += vec3(1.0) * pow(lightUp, 24.0) * 0.6;
    col += uColor * pow(1.0 - ndv, 2.0) * 0.5;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SHARD_VERT = /* glsl */ `
  uniform float uSplit;
  uniform float uDrift;
  uniform vec3 uSpread;
  uniform vec3 uSpreadOffset;
  uniform vec2 uParallax;
  attribute vec3 aCentroid;
  attribute vec3 aTarget;
  attribute vec3 aAxis;
  attribute vec2 aTiming;
  attribute vec3 aBary;
  attribute float aOuter;
  varying vec3 vView;
  varying vec3 vWorld;
  varying vec3 vObj;
  varying vec3 vBary;
  varying float vT;
  varying float vOuter;
  varying vec3 vSmooth;

  vec3 rotateAxis(vec3 v, vec3 k, float a) {
    float c = cos(a);
    float s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }

  void main() {
    float delay = aTiming.x;
    float spinAmt = aTiming.y;
    // Each shard is in flight for half the range; the weak spot breaks first and closes last.
    float t = smoothstep(delay * 0.5, delay * 0.5 + 0.5, uSplit);
    float e = 1.0 - pow(1.0 - t, 3.0);

    vec3 local = position - aCentroid;
    float depth = 0.35 + 0.65 * fract(delay * 13.7);
    float angle = e * spinAmt * 6.2831 + uDrift * spinAmt * 0.5 * t
      + (uParallax.x - uParallax.y) * sign(spinAmt) * 0.7 * depth * t;
    local = rotateAxis(local, aAxis, angle);

    vec3 bob = vec3(
      sin(uDrift * 0.7 + delay * 40.0),
      cos(uDrift * 0.5 + delay * 23.0),
      sin(uDrift * 0.6 + delay * 11.0)
    ) * 0.2 * t;

    vec3 dest = aTarget * uSpread + uSpreadOffset;
    vec3 p = mix(aCentroid, dest, e) + bob + local;

    vObj = position;
    vBary = aBary;
    vOuter = aOuter;
    // A rounded normal, tumbling with the shard, so highlights glide smoothly over the glass.
    vec3 sn = rotateAxis(normalize(position), aAxis, angle);
    vSmooth = normalize((viewMatrix * modelMatrix * vec4(sn, 0.0)).xyz);
    vT = t;
    vec4 w = modelMatrix * vec4(p, 1.0);
    vWorld = w.xyz;
    vec4 mv = viewMatrix * w;
    mv.xy += uParallax * depth * t;
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHARD_FRAG = /* glsl */ `
  uniform vec3 uClear;
  uniform vec3 uBlue;
  uniform vec3 uVulnColor;
  uniform vec3 uMouse;
  uniform vec3 uImpact;
  uniform float uFlash;
  uniform float uVuln;
  uniform float uBreach;
  uniform float uAssembling;
  uniform float uTime;
  varying vec3 vView;
  varying vec3 vWorld;
  varying vec3 vObj;
  varying vec3 vBary;
  varying float vT;
  varying float vOuter;
  varying vec3 vSmooth;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    // Inner (cut) faces only show once a shard has broken away from the crystal.
    float open = smoothstep(0.0, 0.2, vT);
    float faceVis = mix(mix(0.1, 1.0, open), 1.0, vOuter);

    vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
    vec3 v = normalize(-vView);
    float ndv = abs(dot(n, v));
    float fres = pow(1.0 - ndv, 3.0);

    // Once the rebuild starts, a shard that has landed is blue Astra glass.
    float landed = 1.0 - smoothstep(0.0, 0.04, vT);
    float healed = uAssembling * landed;
    vec3 tint = mix(uClear, uBlue, healed);

    // Red creeps out from the weak spot behind the cracks and stays on the shards' edges.
    float spreadDist = (1.0 - dot(normalize(vObj), uImpact)) * 0.5;
    float spread = 1.0 - smoothstep(uBreach - 0.06, uBreach + 0.01, spreadDist);
    float front = (1.0 - smoothstep(0.0, 0.05, abs(spreadDist - uBreach))) * step(uBreach, 1.0) * step(0.001, uBreach);
    float infected = spread * (1.0 - healed);

    // Glossy glass: two sharp highlights, a soft sky reflection and a light streak.
    vec3 ns = normalize(vSmooth);
    ns = dot(ns, v) < 0.0 ? -ns : ns;
    vec3 r = reflect(-v, normalize(mix(n, ns, 0.75)));
    vec3 L1 = normalize(vec3(-0.5, 0.75, 0.6));
    vec3 L2 = normalize(vec3(0.7, -0.25, 0.5));
    float spec = pow(max(dot(r, L1), 0.0), 70.0) * 1.2 + pow(max(dot(r, L2), 0.0), 20.0) * 0.25;
    float sky = smoothstep(-0.2, 0.9, r.y);
    float streak = 1.0 - smoothstep(0.0, 0.04, abs(r.y - 0.28 + 0.18 * r.x + 0.05 * sin(uTime * 0.4)));

    vec3 col = tint * (0.16 + 0.32 * sky) + tint * fres * 0.95 + vec3(1.0) * (spec + streak * 0.3);
    float alpha = 0.08 + 0.5 * fres + 0.1 * sky + spec + streak * 0.22;

    // Cut-glass edges.
    float edgeDist = min(min(vBary.x, vBary.y), vBary.z);
    float edge = (1.0 - smoothstep(0.0, 0.03, edgeDist)) * mix(open * 0.8, mix(0.55, 1.0, open), vOuter);
    vec3 edgeCol = mix(mix(vec3(0.92, 0.95, 1.0), uBlue * 1.45, healed), uVulnColor * 1.25, infected);
    col += edgeCol * edge * 0.75;
    alpha += edge * 0.45;

    col = mix(col, col * 0.65 + uVulnColor * 0.3, infected * 0.45);
    col += vec3(1.0, 0.75, 0.6) * front * 0.7;
    alpha += front * 0.4;

    // Shards flare as they lock back into place.
    float arriving = uAssembling * step(0.0005, vT) * (1.0 - smoothstep(0.0, 0.25, vT));
    col += vec3(0.7, 0.82, 1.0) * arriving * (0.25 + edge * 1.2);
    alpha += arriving * 0.35;

    // Flashlight reveals hidden flaws under the cursor.
    float d = distance(vWorld, uMouse);
    float lit = 1.0 - smoothstep(0.1, 1.05, d);
    float pat = step(0.7, hash(floor(vObj * 7.0)));
    float lines = 0.65 + 0.35 * step(0.5, fract(vObj.y * 36.0));
    col += tint * lit * 0.2 * uFlash;
    col += uVulnColor * lit * pat * lines * uFlash * uVuln * 0.9;
    alpha += lit * uFlash * (0.08 + pat * uVuln * 0.3);

    // Fade shards that come very close to the camera during the fly-through.
    float nearFade = smoothstep(0.5, 1.5, -vView.z);
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92) * nearFade * faceVis);
  }
`;

/* ---------- public API ---------- */

export function initStoryScene(options = {}) {
  if (typeof window === 'undefined' || ctx) return;
  if (document.readyState === 'complete') {
    setup(options);
    return;
  }
  if (pendingLoad) return;
  pendingLoad = () => {
    window.removeEventListener('load', pendingLoad);
    pendingLoad = null;
    if (!ctx) setup(options);
  };
  window.addEventListener('load', pendingLoad);
}

export function destroyStoryScene() {
  if (pendingLoad) {
    window.removeEventListener('load', pendingLoad);
    pendingLoad = null;
  }
  if (!ctx) return;
  ctx.destroy();
  ctx = null;
}

/* ---------- setup ---------- */

function setup(options) {
  const mount = document.querySelector(options.mount || '#scene');
  if (!mount) {
    console.warn('[story-scene] No #scene element found.');
    return;
  }

  gsap.registerPlugin(ScrollTrigger);
  labelFont = options.labelFont || detectFont();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  let mobile = window.innerWidth < 768;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    mount.classList.add('scene--no-webgl');
    console.warn('[story-scene] WebGL unavailable, showing static fallback.');
    return;
  }

  // Keep colors identical across three.js versions (r128 through current).
  if (THREE.ColorManagement) THREE.ColorManagement.enabled = false;
  if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1 : 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  mount.appendChild(renderer.domElement);
  mount.classList.add('scene--ready');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0, 0, 8);

  const C = {
    clear: new THREE.Color(PALETTE.clear),
    blue: new THREE.Color(PALETTE.blue),
    attack: new THREE.Color(PALETTE.attack),
    fixed: new THREE.Color(PALETTE.fixed),
    white: new THREE.Color(PALETTE.white),
  };
  const tmpColor = new THREE.Color();

  const root = new THREE.Group(); // scaled and tilted; does not spin
  const spin = new THREE.Group(); // rotates with the crystal
  root.add(spin);
  scene.add(root);

  const glowTex = makeGlowTexture();
  const dotTex = makeDotTexture();
  const labels = [];
  const rand = seededRandom(1337);

  /* flaw directions (the fracture starts at one of them) */
  const golden = Math.PI * (3 - Math.sqrt(5));
  const endpointDirs = ENDPOINTS.map((_, i) => {
    const y = 1 - ((i + 0.5) / ENDPOINTS.length) * 2;
    const rr = Math.sqrt(1 - y * y);
    const theta = golden * i;
    return new THREE.Vector3(Math.cos(theta) * rr, y * 0.85, Math.sin(theta) * rr).normalize();
  });

  const R = 1.35;

  /* flaws: small red glowing vulnerabilities trapped inside the glass */
  const flaws = [];
  const flawGeo = new THREE.SphereGeometry(0.075, 32, 24);
  const ringGeo = new THREE.RingGeometry(0.17, 0.195, 48);
  ENDPOINTS.forEach((ep, i) => {
    const dir = endpointDirs[i];
    const depthIn = i === IMPACT_ENDPOINT ? 0.8 : 0.45 + rand() * 0.35;
    const pos = dir.clone().multiplyScalar(R * depthIn);

    const coreMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: C.attack.clone() } },
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
    });
    const core = new THREE.Mesh(flawGeo, coreMat);
    core.position.copy(pos);
    core.rotation.set(rand() * 3, rand() * 3, 0);
    core.renderOrder = 1;
    spin.add(core);

    const glowMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: C.attack.clone(),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.position.copy(pos);
    glow.renderOrder = 2;
    spin.add(glow);

    const markerMat = new THREE.MeshBasicMaterial({
      color: C.fixed.clone(),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const marker = new THREE.Mesh(ringGeo, markerMat);
    marker.position.copy(pos);
    marker.renderOrder = 5;
    spin.add(marker);

    const reconLabel = createLabel(ep.recon, { style: 'outline', color: PALETTE.attack, height: 0.15 });
    const foundLabel = createLabel(`CVSS ${ep.cvss.toFixed(1)}  found`, { style: 'outline', color: PALETTE.attack, height: 0.15 });
    const fixedLabel = createLabel('fixed', { style: 'solid', color: PALETTE.fixed, height: 0.15 });
    [reconLabel, foundLabel, fixedLabel].forEach((l) => {
      spin.add(l.sprite);
      labels.push(l);
    });

    flaws.push({
      core,
      glow,
      marker,
      reconLabel,
      foundLabel,
      fixedLabel,
      outside: dir.clone().multiplyScalar(R * 1.3),
      beside: pos.clone().addScaledVector(dir, 0.32).add(new THREE.Vector3(0, 0.12, 0)),
      phase: rand() * Math.PI * 2,
      stagger: (i / ENDPOINTS.length) * 0.7,
    });
  });

  /* crystal made of glass shards */
  const shardMat = new THREE.ShaderMaterial({
    uniforms: {
      uClear: { value: C.clear.clone() },
      uBlue: { value: C.blue.clone() },
      uVulnColor: { value: C.attack.clone() },
      uMouse: { value: new THREE.Vector3(99, 99, 99) },
      uImpact: { value: endpointDirs[IMPACT_ENDPOINT].clone() },
      uFlash: { value: 0 },
      uVuln: { value: 1 },
      uBreach: { value: 0 },
      uAssembling: { value: 0 },
      uSplit: { value: 0 },
      uDrift: { value: 0 },
      uSpread: { value: new THREE.Vector3(1, 1, 1) },
      uSpreadOffset: { value: new THREE.Vector3() },
      uParallax: { value: new THREE.Vector2() },
      uTime: { value: 0 },
    },
    vertexShader: SHARD_VERT,
    fragmentShader: SHARD_FRAG,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  shardMat.extensions = Object.assign(shardMat.extensions || {}, { derivatives: true });
  const crystal = new THREE.Mesh(buildShardGeometry(R, rand, endpointDirs[IMPACT_ENDPOINT]), shardMat);
  crystal.frustumCulled = false;
  crystal.renderOrder = 3;
  spin.add(crystal);

  const haloMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: C.clear.clone(),
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(6.2, 6.2, 1);
  halo.renderOrder = -1;
  root.add(halo);

  /* cracks: a glowing fracture that spreads from the weak spot before it shatters */
  const crackBuild = buildCrackGeometry(R, rand, endpointDirs[IMPACT_ENDPOINT], mobile ? 6 : 8);
  const crackMat = new THREE.ShaderMaterial({
    uniforms: {
      uGrow: { value: 0 },
      uOpacity: { value: 0 },
      uTime: { value: 0 },
      uHot: { value: new THREE.Color('#fff1d6') },
      uRed: { value: C.attack.clone() },
      uDeep: { value: new THREE.Color('#8c120c') },
    },
    vertexShader: CRACK_VERT,
    fragmentShader: CRACK_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const crack = new THREE.Mesh(crackBuild.geometry, crackMat);
  crack.renderOrder = 4;
  spin.add(crack);

  const impactMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: new THREE.Color('#ffb28a'),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const impactGlow = new THREE.Sprite(impactMat);
  impactGlow.position.copy(crackBuild.impactPoint);
  impactGlow.renderOrder = 4;
  spin.add(impactGlow);

  /* scan rings */
  const makeScanRing = (color) => {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.975, 1.0, 128), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 5;
    root.add(mesh);
    return mesh;
  };
  const reconRings = [makeScanRing(C.attack.clone()), makeScanRing(C.attack.clone())];
  const pentestRings = [makeScanRing(C.fixed.clone()), makeScanRing(C.fixed.clone())];

  /* particles */
  const particleCount = mobile ? 220 : 700;
  const pPos = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    const v = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    const d = 2.3 + rand() * 3.4;
    pPos[i * 3] = v.x * d;
    pPos[i * 3 + 1] = v.y * d * 0.8;
    pPos[i * 3 + 2] = v.z * d;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const pMat = new THREE.PointsMaterial({
    size: mobile ? 0.06 : 0.05,
    map: dotTex,
    color: C.clear.clone(),
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(pGeo, pMat);
  scene.add(particles);

  /* compliance badges */
  const badgeGeo = new THREE.TorusGeometry(0.2, 0.012, 8, 64);
  const badges = BADGES.map((name, i) => {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: C.blue.clone(), transparent: true, opacity: 0 });
    const ring = new THREE.Mesh(badgeGeo, mat);
    ring.renderOrder = 6;
    group.add(ring);
    const label = createLabel(name, { style: 'outline', color: PALETTE.blue, height: 0.17 });
    label.sprite.position.set(0, -0.36, 0);
    group.add(label.sprite);
    labels.push(label);
    root.add(group);
    return { group, ring, label, phase: (i / BADGES.length) * Math.PI * 2 };
  });

  /* domain label */
  let domain = DEFAULT_DOMAIN;
  const domainLabel = createLabel(`target: ${domain}`, { style: 'plain', height: 0.22 });
  domainLabel.sprite.material.opacity = 0.85;
  domainLabel.sprite.position.set(0, -2.0, 0);
  root.add(domainLabel.sprite);
  labels.push(domainLabel);

  const setDomain = (value) => {
    domain = sanitizeDomain(value);
    domainLabel.text = `target: ${domain}`;
    drawLabel(domainLabel);
    document.querySelectorAll('[data-domain]').forEach((el) => {
      el.textContent = domain;
    });
  };
  const input = document.querySelector(options.input || '#domain-input');
  const onInput = () => setDomain(input.value);
  if (input) {
    input.addEventListener('input', onInput);
    if (input.value) setDomain(input.value);
  }

  // Redraw labels once the label font has loaded.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (ctx && ctx.renderer === renderer) labels.forEach(drawLabel);
    });
  }

  /* layout: the crystal sits right of the text on desktop and above it on phones */
  let baseScale = 1;
  const layout = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    mobile = w < 768;
    camera.aspect = w / h;
    // Shift the picture instead of the crystal, so zooming in still frames it in the same spot.
    if (w >= 900) camera.setViewOffset(w, h, -0.17 * w, 0, w, h);
    else if (mobile) camera.setViewOffset(w, h, 0, 0.2 * h, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    baseScale = mobile ? 0.62 : 1;
    // On tall phone screens, spread the debris down the whole screen.
    shardMat.uniforms.uSpread.value.set(1, mobile ? 2.2 : 1, 1);
    shardMat.uniforms.uSpreadOffset.value.set(0, mobile ? -0.6 : 0, 0);
  };
  layout();
  window.addEventListener('resize', layout);

  /* pointer: flashlight on the crystal and parallax on the shards */
  const flashEnabled = finePointer && !mobile;
  const mouse = new THREE.Vector2();
  const ndc = new THREE.Vector2(9, 9);
  const raycaster = new THREE.Raycaster();
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), R * 1.25);
  const hitPoint = new THREE.Vector3();
  let pointerActive = false;
  const onPointerMove = (e) => {
    ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointerActive = true;
  };
  const onPointerLeave = () => {
    pointerActive = false;
  };
  if (flashEnabled) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
  }

  /* scroll state */
  const target = { recon: 0, breach: 0, freeze: 0, pentest: 0, fix: 0, cta: 0 };
  const cur = { ...target };
  const triggers = [];
  let activeChapter = 'calm';

  const setActive = (name) => {
    if (name === activeChapter) return;
    activeChapter = name;
    mount.dataset.activeChapter = name;
    window.dispatchEvent(new CustomEvent('storyscene:chapter', { detail: { chapter: name } }));
  };
  mount.dataset.activeChapter = activeChapter;

  document.querySelectorAll('[data-chapter]').forEach((el) => {
    const name = el.dataset.chapter;
    if (!CHAPTERS.includes(name)) return;

    triggers.push(
      ScrollTrigger.create({
        trigger: el,
        start: 'top center',
        end: 'bottom center',
        onToggle: (self) => {
          if (self.isActive) setActive(name);
        },
      })
    );

    if (!SCRUBBED.includes(name)) return;
    const apply = (self) => {
      const p = reduced ? (self.progress > 0.5 ? 1 : 0) : self.progress;
      target[name] = p;
      window.dispatchEvent(new CustomEvent('storyscene:progress', { detail: { chapter: name, progress: self.progress } }));
    };
    triggers.push(
      ScrollTrigger.create({
        trigger: el,
        start: name === 'cta' ? 'top bottom' : 'top 75%',
        end: name === 'cta' ? 'bottom bottom' : 'bottom 40%',
        onUpdate: apply,
        onRefresh: apply,
      })
    );
  });
  ScrollTrigger.refresh();

  /* render loop */
  const clock = new THREE.Clock();
  let raf = 0;
  let time = 0;
  let drift = 0;
  let flash = 0;
  const camDir = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const rootWorld = new THREE.Vector3();

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    time += dt;

    // Ease scroll values (instant when reduced motion is on).
    const k = reduced ? 1 : 1 - Math.exp(-dt * 6);
    for (const key in target) cur[key] = lerp(cur[key], target[key], k);

    const { recon, breach, freeze, pentest, fix, cta } = cur;

    // Story phases.
    const infected = smoothstep(0.0, 0.17, breach); // red spreads from the weak spot
    const crackAmt = smoothstep(0.0, 0.2, breach); // cracks spread first
    const shatter = smoothstep(0.17, 0.8, breach); // then the shards fly apart
    const assemble = smoothstep(0.05, 0.85, fix); // and fly back as blue glass in the fix chapter
    const split = shatter * (1 - assemble);
    const assembling = smoothstep(0.0, 0.04, assemble);
    const zoom = smoothstep(0.2, 0.85, breach) * (1 - smoothstep(0.0, 0.6, fix)); // fly in among the flaws
    const greened = smoothstep(0.45, 0.95, pentest); // overall share of flaws fixed
    const red = infected * (1 - greened);
    const hold = smoothstep(0.02, 0.12, freeze) * (1 - smoothstep(0.0, 0.08, pentest)); // frozen in mid-air

    // Motion: idle spin, debris drifts, everything stops on freeze.
    if (!reduced) {
      const speed = (0.18 + 0.1 * split) * (1 - hold) * (1 - zoom * 0.6);
      spin.rotation.y += speed * dt;
      spin.rotation.x = 0.28 + Math.sin(time * 0.3) * 0.05 * (1 - hold);
      particles.rotation.y += speed * 0.25 * dt;
      drift += dt * (1 - hold);
    } else {
      spin.rotation.x = 0.28;
    }

    const breathe = reduced ? 1 : 1 + Math.sin(time * 1.4) * 0.012 * (1 - hold) * (1 - split);
    root.scale.setScalar(baseScale * (1 + cta * 0.15) * breathe);

    // Mouse: shards drift with the cursor; the whole crystal leans toward it.
    const mk = 1 - Math.exp(-dt * 4);
    mouse.x = lerp(mouse.x, flashEnabled && pointerActive ? ndc.x : 0, mk);
    mouse.y = lerp(mouse.y, flashEnabled && pointerActive ? ndc.y : 0, mk);
    shardMat.uniforms.uParallax.value.set(mouse.x * 0.4, mouse.y * 0.3);
    root.rotation.y = mouse.x * 0.22 * (1 - split);
    root.rotation.x = -mouse.y * 0.14 * (1 - split);
    root.updateMatrixWorld();
    root.getWorldPosition(rootWorld);

    // Camera: dolly out for recon, lean in as it cracks, fly in among the flaws once it shatters,
    // orbit them while scrolling (even when time is frozen), pull back out as it rebuilds.
    const dollyOut = recon * (1 - breach);
    const camZ = 8 + 1.3 * dollyOut - 0.6 * crackAmt * (1 - shatter) - 4.4 * zoom - 0.7 * cta;
    const orbit = zoom * (1.1 * breach + 0.7 * freeze + 0.9 * pentest);
    const camY = zoom * 0.45 * Math.sin((breach + freeze + pentest) * 1.6);
    camera.position.set(Math.sin(orbit) * camZ, camY, Math.cos(orbit) * camZ);
    const shake = crackAmt * (1 - shatter);
    if (!reduced && !mobile && shake > 0.01) {
      camera.position.x += (Math.random() - 0.5) * 0.08 * shake;
      camera.position.y += (Math.random() - 0.5) * 0.08 * shake;
    }
    camera.lookAt(0, 0, 0);

    // Glass.
    shardMat.uniforms.uSplit.value = split;
    shardMat.uniforms.uDrift.value = drift;
    shardMat.uniforms.uBreach.value = infected * 1.1;
    shardMat.uniforms.uAssembling.value = assembling;
    shardMat.uniforms.uVuln.value = 1 - greened;
    shardMat.uniforms.uTime.value = time;

    tmpColor.copy(C.clear).lerp(C.attack, red * (1 - assemble)).lerp(C.blue, assemble);
    haloMat.color.copy(tmpColor);
    haloMat.opacity = (0.16 + 0.22 * red + 0.2 * assemble + 0.1 * cta) * (1 - 0.8 * split);
    pMat.color.copy(tmpColor);
    particles.scale.setScalar(1 + split * 0.5);
    pMat.opacity = 0.55 - split * 0.15;

    // Cracks spread from the weak spot, then vanish as the crystal comes apart.
    const crackFade = 1 - smoothstep(0.0, 0.06, shatter);
    crackMat.uniforms.uGrow.value = crackAmt * 1.08;
    crackMat.uniforms.uOpacity.value = smoothstep(0.0, 0.02, crackAmt) * crackFade;
    crackMat.uniforms.uTime.value = time;
    crack.visible = crackAmt > 0.001 && crackFade > 0.001;
    impactMat.opacity = crackAmt * crackFade * (0.8 + 0.2 * Math.sin(time * 10));
    impactGlow.scale.setScalar(0.5 + crackAmt * 0.7);

    // Scan rings.
    const sweep = (rings, p, fade) => {
      const env = smoothstep(0.02, 0.12, p) * (1 - smoothstep(0.86, 0.98, p)) * fade;
      rings.forEach((ring, i) => {
        const phase = (p * 2.5 + i * 0.12) % 1;
        const y = lerp(1.65, -1.65, phase);
        const radius = Math.sqrt(Math.max(1.8 * 1.8 - y * y, 0.04));
        ring.position.y = y;
        ring.scale.set(radius, radius, radius);
        ring.material.opacity = env * (i === 0 ? 0.9 : 0.35);
      });
    };
    sweep(reconRings, recon, 1 - smoothstep(0.0, 0.25, breach));
    sweep(pentestRings, pentest, 1);

    // Flaws: faint inside the glass, close-up during the fly-through, red until the pentest fixes them.
    camDir.copy(camera.position).sub(rootWorld).normalize();
    const labelScale = mobile ? 0.8 : 1;
    flaws.forEach((fl) => {
      const s = fl.stagger;
      // Keep labels and rings a steady size on screen as the camera flies in.
      fl.core.getWorldPosition(worldPos);
      const near = clamp01(camera.position.distanceTo(worldPos) / 8);
      const sizeFix = lerp(1, Math.max(0.35, near * 1.15), zoom);
      const seen = smoothstep(s, s + 0.15, recon);
      const found = smoothstep(s * 0.5, s * 0.5 + 0.1, pentest);
      const green = smoothstep(0.45 + s * 0.5, 0.55 + s * 0.5, pentest);

      const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(time * 3 + fl.phase);
      fl.core.material.uniforms.uColor.value.copy(C.attack).lerp(C.fixed, green);
      fl.glow.material.color.copy(fl.core.material.uniforms.uColor.value);
      fl.glow.material.opacity = (0.45 + 0.35 * zoom + 0.2 * crackAmt * (1 - shatter)) * pulse;
      fl.glow.scale.setScalar(0.55 * lerp(1, 1.6 * sizeFix, zoom) * (1 + 0.6 * green * (1 - green)));
      fl.core.scale.setScalar(1 + 0.3 * zoom);
      if (!reduced) {
        fl.core.rotation.x += dt * 0.7;
        fl.core.rotation.y += dt * 0.5;
      }

      fl.marker.lookAt(camera.position);
      fl.marker.material.opacity = found * (1 - green) * 0.9;
      fl.marker.scale.setScalar(sizeFix * (1 + (reduced ? 0 : 0.12 * Math.sin(time * 4 + fl.phase))));

      // Labels sit outside the crystal while it is whole and next to the flaw once it is open.
      const facingWhole = smoothstep(-0.05, 0.4, worldPos.sub(rootWorld).normalize().dot(camDir));
      const facing = lerp(facingWhole, 1, zoom);
      const show = 1 - cta;
      [fl.reconLabel, fl.foundLabel, fl.fixedLabel].forEach((l) => {
        l.sprite.position.lerpVectors(fl.outside, fl.beside, zoom);
        const hgt = l.height * labelScale * sizeFix;
        l.sprite.scale.set((hgt * l.canvas.width) / l.canvas.height, hgt, 1);
      });
      fl.reconLabel.sprite.material.opacity = seen * (1 - found) * facing * show;
      fl.foundLabel.sprite.material.opacity = found * (1 - green) * facing * show;
      fl.fixedLabel.sprite.material.opacity = green * (1 - assemble * 0.7) * facing * show;
    });

    // Compliance badges orbit once the crystal is whole again.
    badges.forEach((b) => {
      const a = (reduced ? 0 : time * 0.35) + b.phase;
      const radius = 2.45;
      b.group.position.set(Math.cos(a) * radius, Math.sin(a) * 0.55 - 0.1, Math.sin(a) * radius);
      b.ring.lookAt(camera.position);
      const vis = smoothstep(0.7, 1.0, fix);
      b.ring.material.opacity = vis;
      b.label.sprite.material.opacity = vis;
      b.group.scale.setScalar(0.6 + 0.4 * vis);
    });

    // Domain label: tinted with the story color, larger for the CTA.
    domainLabel.sprite.material.color.copy(tmpColor).lerp(C.white, 0.35);
    domainLabel.sprite.material.opacity = (0.75 + 0.25 * cta) * (1 - 0.8 * zoom);
    domainLabel.sprite.position.y = -2.0 - 0.1 * cta;
    const dScale = 1 + cta * 0.45;
    domainLabel.sprite.scale.set(
      (domainLabel.height * dScale * domainLabel.canvas.width) / domainLabel.canvas.height,
      domainLabel.height * dScale,
      1
    );

    // Flashlight (only while the crystal is whole).
    let flashTarget = 0;
    if (flashEnabled && pointerActive && split < 0.05) {
      raycaster.setFromCamera(ndc, camera);
      hitSphere.center.copy(rootWorld);
      if (raycaster.ray.intersectSphere(hitSphere, hitPoint)) {
        shardMat.uniforms.uMouse.value.copy(hitPoint);
        flashTarget = 1;
      }
    }
    flash = lerp(flash, flashTarget, 1 - Math.exp(-dt * 10));
    shardMat.uniforms.uFlash.value = flash;

    renderer.render(scene, camera);
  };

  const start = () => {
    if (raf) return;
    clock.getDelta();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) start();

  const destroy = () => {
    stop();
    triggers.forEach((t) => t.kill());
    window.removeEventListener('resize', layout);
    window.removeEventListener('pointermove', onPointerMove);
    document.documentElement.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('visibilitychange', onVisibility);
    if (input) input.removeEventListener('input', onInput);

    const disposed = new Set();
    scene.traverse((obj) => {
      if (obj.geometry && !disposed.has(obj.geometry)) {
        obj.geometry.dispose();
        disposed.add(obj.geometry);
      }
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      mats.forEach((m) => {
        if (disposed.has(m)) return;
        if (m.map) m.map.dispose();
        m.dispose();
        disposed.add(m);
      });
    });
    glowTex.dispose();
    dotTex.dispose();
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    renderer.domElement.remove();
    mount.classList.remove('scene--ready');
    delete mount.dataset.activeChapter;
  };

  ctx = {
    renderer,
    destroy,
    api: { setDomain, getState: () => ({ ...cur, chapter: activeChapter }) },
  };
}
