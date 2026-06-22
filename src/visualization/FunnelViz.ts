import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Code } from '../engine/types';

// ─── Color palette ────────────────────────────────────────────────────────────
// Matches the UI peg colors: Red, Orange, Yellow, Green, Blue, Purple
const PALETTE: [number, number, number][] = [
  [0.95, 0.22, 0.18], // Red
  [0.95, 0.54, 0.10], // Orange
  [0.95, 0.84, 0.10], // Yellow
  [0.12, 0.82, 0.35], // Green
  [0.15, 0.45, 0.95], // Blue
  [0.72, 0.12, 0.95], // Purple
];

function codeToColor(code: Code): [number, number, number] {
  // Blend palette entries weighted by peg position importance
  const weights = [0.50, 0.30, 0.14, 0.06];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < code.length; i++) {
    const p = PALETTE[code[i]];
    r += p[0] * weights[i];
    g += p[1] * weights[i];
    b += p[2] * weights[i];
  }
  return [r, g, b];
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/**
 * Evenly distribute n points on a sphere of the given radius using the
 * Fibonacci / golden-ratio method.  The same index always maps to the same
 * position, so code colours are stable across filter operations.
 */
function fibonacciSphere(n: number, radius: number): Float32Array {
  const positions = new Float32Array(n * 3);
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / goldenRatio;
    const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
    const sinPhi = Math.sin(phi);
    positions[i * 3] = radius * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = radius * sinPhi * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  return positions;
}

// ─── Shaders ──────────────────────────────────────────────────────────────────

const VERTEX_SHADER = /* glsl */ `
  attribute float size;
  attribute vec3 aColor;
  attribute float opacity;
  varying vec3 vColor;
  varying float vOpacity;

  void main() {
    vColor   = aColor;
    vOpacity = opacity;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (400.0 / -mvPosition.z);
    gl_Position  = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  varying vec3  vColor;
  varying float vOpacity;

  void main() {
    vec2  coord = gl_PointCoord - vec2(0.5);
    float dist  = length(coord);
    if (dist > 0.5) discard;
    float alpha = vOpacity * (1.0 - smoothstep(0.3, 0.5, dist));
    gl_FragColor = vec4(vColor, alpha);
  }
`;

// ─── FunnelViz ────────────────────────────────────────────────────────────────

interface ParticleState {
  active: boolean;
  /** 0 = fully on inner sphere (active), 1 = fully on outer sphere (eliminated) */
  elimProgress: number;
}

const INNER_RADIUS = 15;
const OUTER_RADIUS = 28;
const ACTIVE_SIZE = 4.0;
const ELIM_SIZE = 1.2;

export class FunnelViz {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private clock: THREE.Clock;

  // Particle system
  private geometry: THREE.BufferGeometry;
  private posArray: Float32Array;
  private colorArray: Float32Array;
  private sizeArray: Float32Array;
  private opacityArray: Float32Array;

  private posAttr: THREE.BufferAttribute;
  private colorAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private opacityAttr: THREE.BufferAttribute;

  /** Stable base positions for each code on the inner sphere */
  private readonly innerPos: Float32Array;
  /** Target positions on the outer sphere for eliminated codes */
  private readonly outerPos: Float32Array;
  /** Base (bright) colour for each code particle */
  private readonly baseColors: Float32Array;

  private states: ParticleState[];
  private readonly count: number;

  private animFrameId = 0;
  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, allCodes: readonly Code[]) {
    this.count = allCodes.length;

    // ── Scene ──────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();

    // ── Camera ─────────────────────────────────────────────────────────────
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 500);
    this.camera.position.set(0, 8, 52);

    // ── Renderer ───────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x050510, 1);

    // ── Controls ───────────────────────────────────────────────────────────
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 120;

    // ── Pre-compute positions and base colours ──────────────────────────────
    this.innerPos = fibonacciSphere(this.count, INNER_RADIUS);
    this.outerPos = fibonacciSphere(this.count, OUTER_RADIUS);

    this.baseColors = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      const [r, g, b] = codeToColor(allCodes[i]);
      this.baseColors[i * 3] = r;
      this.baseColors[i * 3 + 1] = g;
      this.baseColors[i * 3 + 2] = b;
    }

    // ── Particle state ──────────────────────────────────────────────────────
    this.states = Array.from({ length: this.count }, () => ({
      active: true,
      elimProgress: 0,
    }));

    // ── Buffer geometry ─────────────────────────────────────────────────────
    this.posArray = this.innerPos.slice();
    this.colorArray = this.baseColors.slice();
    this.sizeArray = new Float32Array(this.count).fill(ACTIVE_SIZE);
    this.opacityArray = new Float32Array(this.count).fill(1.0);

    this.posAttr = new THREE.BufferAttribute(this.posArray, 3);
    this.colorAttr = new THREE.BufferAttribute(this.colorArray, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.sizeArray, 1);
    this.opacityAttr = new THREE.BufferAttribute(this.opacityArray, 1);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('size', this.sizeAttr);
    this.geometry.setAttribute('opacity', this.opacityAttr);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.scene.add(new THREE.Points(this.geometry, material));

    // ── Background star field ───────────────────────────────────────────────
    this.buildStarField();

    // ── Reference sphere wireframe ─────────────────────────────────────────
    const sphereGeo = new THREE.SphereGeometry(INNER_RADIUS, 24, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a3a,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
    });
    this.scene.add(new THREE.Mesh(sphereGeo, sphereMat));

    // ── Responsive resize ───────────────────────────────────────────────────
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(canvas);

    // ── Start render loop ──────────────────────────────────────────────────
    this.animate();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Update which codes are still in the active (remaining) set.
   * Codes not in `activeIndices` will animate toward the outer sphere and fade.
   * Codes that become active again (e.g. on reset) animate back inward.
   */
  updateActiveSet(activeIndices: Set<number>): void {
    for (let i = 0; i < this.count; i++) {
      const shouldBeActive = activeIndices.has(i);
      this.states[i].active = shouldBeActive;
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((object) => {
      if ('geometry' in object) {
        const geometry = object.geometry as THREE.BufferGeometry | undefined;
        geometry?.dispose();
      }
      if ('material' in object) {
        const material = object.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) {
          material.forEach((m) => m.dispose());
        } else {
          material?.dispose();
        }
      }
    });
    this.renderer.dispose();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildStarField(): void {
    const STARS = 350;
    const starPos = new Float32Array(STARS * 3);
    for (let i = 0; i < STARS; i++) {
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 90 + Math.random() * 30;
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xaabbff,
      size: 0.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
    });
    this.scene.add(new THREE.Points(starGeo, starMat));
  }

  private handleResize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.animFrameId = requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.1); // cap at 100 ms

    const ELIM_SPEED = 1.0;    // progress units per second toward eliminated
    const RESTORE_SPEED = 2.0; // progress units per second toward active

    // Dim eliminated colour (grey) and dim active colour (bright)
    const GR = 0.18, GG = 0.18, GB = 0.25; // "fog" colour for eliminated

    let needsUpdate = false;

    for (let i = 0; i < this.count; i++) {
      const state = this.states[i];
      const prev = state.elimProgress;

      if (!state.active) {
        state.elimProgress = Math.min(1, prev + delta * ELIM_SPEED);
      } else {
        state.elimProgress = Math.max(0, prev - delta * RESTORE_SPEED);
      }

      if (state.elimProgress === prev) continue;
      needsUpdate = true;

      const t = state.elimProgress;

      // Position: lerp inner → outer
      const ix = this.innerPos[i * 3], iy = this.innerPos[i * 3 + 1], iz = this.innerPos[i * 3 + 2];
      const ox = this.outerPos[i * 3], oy = this.outerPos[i * 3 + 1], oz = this.outerPos[i * 3 + 2];
      this.posArray[i * 3] = ix + (ox - ix) * t;
      this.posArray[i * 3 + 1] = iy + (oy - iy) * t;
      this.posArray[i * 3 + 2] = iz + (oz - iz) * t;

      // Colour: lerp base colour → grey fog
      const br = this.baseColors[i * 3], bg = this.baseColors[i * 3 + 1], bb = this.baseColors[i * 3 + 2];
      this.colorArray[i * 3] = br + (GR - br) * t;
      this.colorArray[i * 3 + 1] = bg + (GG - bg) * t;
      this.colorArray[i * 3 + 2] = bb + (GB - bb) * t;

      // Size and opacity
      this.sizeArray[i] = ACTIVE_SIZE + (ELIM_SIZE - ACTIVE_SIZE) * t;
      this.opacityArray[i] = 1.0 - 0.82 * t;
    }

    if (needsUpdate) {
      this.posAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.opacityAttr.needsUpdate = true;
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
