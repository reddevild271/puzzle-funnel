import * as THREE from 'three';
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

// ── Camera constants ──────────────────────────────────────────────────────────
/** Initial camera position (fixed orientation, only distance scales with zoom). */
const CAM_INIT = new THREE.Vector3(0, 8, 52);
const CAM_INIT_DIST = CAM_INIT.length(); // ≈ 52.6
const CAM_MIN = 20;   // minimum zoom distance
const CAM_MAX = 120;  // maximum zoom distance

// ── Interaction constants ─────────────────────────────────────────────────────
/** Rotation sensitivity: fraction of viewport width/height → π radians. */
const ROT_SENS = 2.5;
/** Per-frame velocity decay for rotation and pan damping (0 = instant, 1 = no decay). */
const DAMPING = 0.88;
/** Auto-rotate speed in radians per frame at 60 fps. */
const AUTO_SPEED = 0.003;
/** Idle time in ms before auto-rotate resumes after user interaction. */
const AUTO_RESUME_DELAY = 2500;

export class FunnelViz {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;

  /**
   * All sphere geometry lives inside worldGroup.
   * Rotating worldGroup.quaternion spins the sphere around its own local origin —
   * the pivot is always the sphere centre, regardless of where it has been panned.
   * worldGroup.position holds the pan offset in world XY.
   */
  private worldGroup: THREE.Group;

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

  // ── Camera state ──────────────────────────────────────────────────────────
  /** Current camera distance from the coordinate origin (zoom level). */
  private camDist = CAM_INIT_DIST;
  /**
   * World-XY offset of the sphere group.
   * The camera direction is fixed; panning moves the sphere in world space so
   * it appears to shift on screen without changing the rotation pivot.
   */
  private panWorld = new THREE.Vector2();

  // ── Rotation velocity (for inertia / damping) ─────────────────────────────
  /** Angular velocity around camera's right axis (vertical drag). */
  private rotVelX = 0;
  /** Angular velocity around world Y axis (horizontal drag). */
  private rotVelY = 0;

  // ── Pointer tracking ──────────────────────────────────────────────────────
  /** Active pointer positions keyed by pointerId. */
  private pointers = new Map<number, { x: number; y: number }>();
  /** Centroid of the previous frame's two-pointer positions. */
  private prevCentroid = new THREE.Vector2();
  /** Distance between two pointers on the previous frame. */
  private prevSpread = 0;
  /**
   * True while two or more pointers are active (pan/zoom mode).
   * Cleared on the frame after all extra pointers are released so a stale
   * pointer position cannot contaminate the first rotate delta.
   */
  private isPanMode = false;

  // ── Auto-rotate ───────────────────────────────────────────────────────────
  private autoRotating = true;
  private autoResumeTimer = 0;

  // ── Viewport centering ────────────────────────────────────────────────────
  /** Height in CSS px of the bottom UI panel (set by App via setBottomInset). */
  private bottomInset = 0;

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
    this.positionCamera();

    // ── Renderer ───────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x050510, 1);

    // ── World group ────────────────────────────────────────────────────────
    // All sphere geometry lives here so rotation/pan transforms are cleanly
    // separated: worldGroup.quaternion = spin, worldGroup.position = pan offset.
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

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

    this.worldGroup.add(new THREE.Points(this.geometry, material));

    // ── Background star field ───────────────────────────────────────────────
    // Stars are added to the scene (not worldGroup) so they never rotate/pan
    // with the sphere and provide a stable frame of reference.
    this.buildStarField();

    // ── Reference sphere wireframe ─────────────────────────────────────────
    const sphereGeo = new THREE.SphereGeometry(INNER_RADIUS, 24, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x1a1a3a,
      wireframe: true,
      transparent: true,
      opacity: 0.08,
    });
    this.worldGroup.add(new THREE.Mesh(sphereGeo, sphereMat));

    // ── Pointer interaction ─────────────────────────────────────────────────
    // touch-action:none lets the browser deliver pointer events for all touches
    // instead of handling them as scroll/pinch-zoom gestures.
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

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

  /**
   * Set the height (CSS px) of the bottom UI panel so the sphere is initially
   * centered in the visible free area above it.
   * Call this whenever the panel height changes (resize, orientation change).
   */
  setBottomInset(inset: number): void {
    this.bottomInset = inset;
    this.applyViewOffset();
  }

  dispose(): void {
    cancelAnimationFrame(this.animFrameId);
    clearTimeout(this.autoResumeTimer);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
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

  // ── Camera helpers ─────────────────────────────────────────────────────────

  /**
   * Position the camera along the fixed initial ray at the current zoom distance.
   * The camera direction never changes — only the distance scales.  This keeps
   * the camera's right/up axes constant so rotation input mapping is predictable.
   */
  private positionCamera(): void {
    const scale = this.camDist / CAM_INIT_DIST;
    this.camera.position.copy(CAM_INIT).multiplyScalar(scale);
    this.camera.lookAt(0, 0, 0);
    // Ensure matrixWorld is up-to-date for right/up axis lookups in rotate/pan.
    this.camera.updateMatrixWorld();
  }

  /**
   * Shift the camera's projection frustum so the coordinate origin (where the
   * sphere starts before any pan) appears at the centre of the free viewport
   * above the bottom UI panel.
   *
   * On orientation change this is re-called with the same bottomInset so the
   * sphere stays in the free area without resetting its world position.
   */
  private applyViewOffset(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const freeH = h - this.bottomInset;
    if (freeH <= 0) return;

    // Shift the virtual frustum DOWN by half the panel height.
    // This remaps the frustum centre from (w/2, h/2) to (w/2, freeH/2) on the
    // actual canvas, so the sphere at world origin appears at the free-area centre.
    const dy = (h - freeH) / 2; // = bottomInset / 2
    this.camera.setViewOffset(w, h, 0, dy, w, h);
    this.camera.updateProjectionMatrix();
  }

  // ── Pointer event handlers ─────────────────────────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
    // Capture the pointer so moves/ups are received even outside the canvas.
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Stop auto-rotate on first touch; cancel any pending resume.
    this.autoRotating = false;
    clearTimeout(this.autoResumeTimer);

    if (this.pointers.size >= 2) {
      // Transition to pan/zoom mode.
      // Clear stale rotate velocity so it cannot contaminate the first pan frame.
      this.rotVelX = 0;
      this.rotVelY = 0;
      this.isPanMode = true;
      const [a, b] = [...this.pointers.values()];
      this.prevCentroid.set((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.prevSpread = Math.hypot(b.x - a.x, b.y - a.y);
    } else {
      this.isPanMode = false;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;

    // Update stored position AFTER reading prev so delta is correct.
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1 && !this.isPanMode) {
      // ── 1-pointer: rotate sphere in object space ──────────────────────────
      // Rotation is applied to worldGroup.quaternion, so the pivot is always
      // the sphere's local origin regardless of the current pan offset.
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      this.applyRotation(dx, dy);

    } else if (this.pointers.size >= 2) {
      // ── 2-pointer: pan sphere world position + pinch zoom ─────────────────
      const pts = [...this.pointers.values()];
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const spread = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

      this.applyPan(cx - this.prevCentroid.x, cy - this.prevCentroid.y);

      // Pinch zoom: ratio of previous/current spread scales the camera distance.
      if (this.prevSpread > 1) {
        this.camDist = Math.max(
          CAM_MIN,
          Math.min(CAM_MAX, this.camDist * (this.prevSpread / spread)),
        );
        this.positionCamera();
      }

      this.prevCentroid.set(cx, cy);
      this.prevSpread = spread;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    const prevSize = this.pointers.size;
    this.pointers.delete(e.pointerId);

    if (this.pointers.size === 0) {
      // All fingers lifted — schedule auto-rotate resumption.
      this.autoResumeTimer = window.setTimeout(() => {
        this.autoRotating = true;
      }, AUTO_RESUME_DELAY);

    } else if (prevSize >= 2 && this.pointers.size === 1) {
      // ── 2-finger → 1-finger transition ───────────────────────────────────
      // Finalize pan: clear pan velocity and stale rotate velocity so neither
      // contaminates the next 1-finger rotate gesture.
      this.isPanMode = false;
      this.rotVelX = 0;
      this.rotVelY = 0;
      // Seed prevCentroid to the surviving pointer so the first rotate delta
      // starts from the correct position on the next pointermove.
      const [p] = [...this.pointers.values()];
      this.prevCentroid.set(p.x, p.y);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalise across different deltaMode values.
    const delta = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
    this.camDist = Math.max(CAM_MIN, Math.min(CAM_MAX, this.camDist + delta * 0.05));
    this.positionCamera();
  };

  // ── Interaction helpers ────────────────────────────────────────────────────

  /**
   * Rotate worldGroup in world space based on a screen-pixel drag delta.
   * Pre-multiplying quaternions applies rotation in world space, so the pivot
   * is always the object's own centre.
   */
  private applyRotation(dx: number, dy: number): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;

    // Map pixel delta → radians (full viewport width/height = π * ROT_SENS radians).
    const dTheta = -(dx / w) * Math.PI * ROT_SENS;
    const dPhi   = -(dy / h) * Math.PI * ROT_SENS;

    // Horizontal drag → rotate around world Y axis.
    const qY = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), dTheta,
    );
    // Vertical drag → rotate around the camera's right axis so "up on screen"
    // always means "up" regardless of the current sphere orientation.
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const qX = new THREE.Quaternion().setFromAxisAngle(camRight, dPhi);

    this.worldGroup.quaternion.premultiply(qY).premultiply(qX);

    // Accumulate velocity for damped coast after pointer release.
    // Use assignment (not +=) so velocity equals the last gesture delta,
    // which is the correct coasting speed at the moment of release.
    this.rotVelY = dTheta;
    this.rotVelX = dPhi;
  }

  /**
   * Translate the sphere's world position by a screen-pixel pan delta.
   * The camera direction is fixed so the sphere appears to move on screen,
   * and the rotation pivot (worldGroup's local origin) moves with it.
   */
  private applyPan(dcx: number, dcy: number): void {
    const canvas = this.renderer.domElement;
    const h = canvas.clientHeight || 1;

    // World height visible at the current camera distance.
    const vFov = this.camera.fov * THREE.MathUtils.DEG2RAD;
    const worldHeight = 2 * Math.tan(vFov / 2) * this.camDist;
    const pxToWorld = worldHeight / h;

    // Camera right and up in world space (matrixWorld is kept current by positionCamera).
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const camUp    = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    // Drag right/down → sphere moves right/down in screen space.
    this.panWorld.x += (dcx * camRight.x - dcy * camUp.x) * pxToWorld;
    this.panWorld.y += (dcx * camRight.y - dcy * camUp.y) * pxToWorld;

    this.worldGroup.position.set(this.panWorld.x, this.panWorld.y, 0);
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
    // Recompute the frustum offset for the (possibly new) panel height and
    // canvas dimensions. This preserves the world state (panWorld, quaternion)
    // so the current focal point stays in the free-space area after orientation change.
    this.applyViewOffset();
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

    // ── Auto-rotate sphere around world Y when idle ────────────────────────
    if (this.autoRotating) {
      const qAuto = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        AUTO_SPEED,
      );
      this.worldGroup.quaternion.premultiply(qAuto);
    } else if (this.pointers.size === 0) {
      // Apply damped rotation inertia only when no pointer is active.
      // While a pointer is active, rotation is applied directly in applyRotation()
      // to avoid double-application.
      if (Math.abs(this.rotVelX) > 1e-5 || Math.abs(this.rotVelY) > 1e-5) {
        const qY = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0), this.rotVelY,
        );
        const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const qX = new THREE.Quaternion().setFromAxisAngle(camRight, this.rotVelX);
        this.worldGroup.quaternion.premultiply(qY).premultiply(qX);
        this.rotVelX *= DAMPING;
        this.rotVelY *= DAMPING;
      }
    }

    this.renderer.render(this.scene, this.camera);
  };
}
