import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import {
  BooleanOp, EngineMessage, EngineState, MeasureResult, ObjectInfo, ObjectKind, Params,
  PrimitiveKind, Tool, TransformMode, Vec3, ViewName, primitiveSpec,
} from './fucad-model';

// The FuCad 3D workspace: scene, camera, picking, gizmos, history and file I/O.
// The Angular page owns the UI and calls into this class; the class reports back through onState.

const DEFAULT_COLOR = '#c8c8d0';
const EDGE_COLOR = 0x15151b;
const SELECT_EDGE_COLOR = 0xa855f7;
const SELECT_EMISSIVE = 0x2c1258;
const MAX_HISTORY = 60;
const AUTOSAVE_KEY = 'fucad-autosave';
const FILE_FORMAT = 'fucad-web';

interface Entry {
  id: string;
  name: string;
  kind: ObjectKind;
  params: Params | null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  color: string;
  visible: boolean;
  triangles: number;
}

// One object in a history snapshot. Primitive geometry is rebuilt from params; feature geometry
// (booleans, imports) is never modified after creation, so snapshots can share it.
interface SnapItem {
  id: string;
  name: string;
  kind: ObjectKind;
  params: Params | null;
  geometry: THREE.BufferGeometry | null;
  color: string;
  visible: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

interface Snapshot {
  items: SnapItem[];
  selected: string[];
}

interface SavedObject {
  id: string;
  name: string;
  kind: ObjectKind;
  params?: Params;
  mesh?: { position: number[]; normal?: number[] };
  color: string;
  visible: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export function buildPrimitive(kind: PrimitiveKind, p: Params): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (kind) {
    case 'Box':
      g = new THREE.BoxGeometry(p['length'], p['width'], p['height']).translate(0, 0, p['height'] / 2);
      break;
    case 'Cylinder':
      g = new THREE.CylinderGeometry(p['radius'], p['radius'], p['height'], 64)
        .rotateX(Math.PI / 2).translate(0, 0, p['height'] / 2);
      break;
    case 'Sphere':
      g = new THREE.SphereGeometry(p['radius'], 64, 32).translate(0, 0, p['radius']);
      break;
    case 'Cone':
      g = new THREE.CylinderGeometry(p['radius2'], p['radius1'], p['height'], 64)
        .rotateX(Math.PI / 2).translate(0, 0, p['height'] / 2);
      break;
    case 'Torus':
      g = new THREE.TorusGeometry(p['radius'], p['tube'], 32, 96).translate(0, 0, p['tube']);
      break;
    case 'Prism':
      g = new THREE.CylinderGeometry(p['circumradius'], p['circumradius'], p['height'], Math.max(3, Math.round(p['sides'])), 1)
        .rotateX(Math.PI / 2).translate(0, 0, p['height'] / 2);
      break;
    case 'Tube': {
      const ri = p['innerRadius'], ro = p['outerRadius'], h = p['height'];
      const profile = [
        new THREE.Vector2(ri, 0), new THREE.Vector2(ro, 0), new THREE.Vector2(ro, h),
        new THREE.Vector2(ri, h), new THREE.Vector2(ri, 0),
      ];
      g = new THREE.LatheGeometry(profile, 64).rotateX(Math.PI / 2);
      g = g.toNonIndexed();
      g.computeVertexNormals();
      break;
    }
  }
  g.deleteAttribute('uv');
  g.clearGroups();
  return g;
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function vec(v: THREE.Vector3 | THREE.Euler): Vec3 {
  return [v.x, v.y, v.z];
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

// Moves a geometry so its bounding box sits centred on X/Y with its base at Z = 0, and returns
// the offset to use as the object's position so the shape stays where it was.
function rebaseGeometry(g: THREE.BufferGeometry): THREE.Vector3 {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const offset = new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z);
  g.translate(-offset.x, -offset.y, -offset.z);
  return offset;
}

function triangleCount(g: THREE.BufferGeometry): number {
  return Math.floor((g.index ? g.index.count : g.getAttribute('position').count) / 3);
}

export class FucadEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly orbit: OrbitControls;
  private readonly transform: TransformControls;
  private readonly root = new THREE.Group();
  private readonly measureGroup = new THREE.Group();
  private readonly grid: THREE.Group;
  private readonly axisScene = new THREE.Scene();
  private readonly axisCamera = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver: ResizeObserver;

  private entries: Entry[] = [];
  private selected: string[] = [];
  private mode: TransformMode = 'translate';
  private tool: Tool = 'select';
  private snap = false;
  private wireframe = false;
  private gridVisible = true;
  private measurePoints: THREE.Vector3[] = [];
  private measureResult: MeasureResult | null = null;
  private message: EngineMessage | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private current: Snapshot = { items: [], selected: [] };

  private idCounter = 0;
  private frame = 0;
  private emitQueued = false;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private pointerDown: { x: number; y: number } | null = null;
  private gizmoClick = false;
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly onState: (s: EngineState) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    const canvas = this.renderer.domElement;
    canvas.classList.add('fc-canvas');
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(90, -120, 80);
    this.scene.add(this.camera);

    // Lighting: soft ambient sky plus a headlight that follows the camera, like FreeCAD.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x50505a, 1.4));
    const headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    headlight.position.set(0.3, 0.6, 1);
    this.camera.add(headlight);

    this.grid = this.buildGrid();
    this.scene.add(this.grid, this.root, this.measureGroup);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.screenSpacePanning = true;

    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setSize(0.9);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', e => { this.orbit.enabled = !e.value; });
    this.transform.addEventListener('mouseDown', () => { this.gizmoClick = true; });
    this.transform.addEventListener('objectChange', () => this.emitSoon());
    this.transform.addEventListener('mouseUp', () => this.commit());

    this.buildAxisTriad();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('dblclick', this.onDoubleClick);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    if (!this.loadAutosave()) {
      this.current = this.snapshot();
    }
    this.fit();
    this.loop();
    this.emit();
  }

  // ---------------------------------------------------------------- scene setup

  private buildGrid(): THREE.Group {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(400, 80, 0x3a3b48, 0x2c2d38);
    const major = new THREE.GridHelper(400, 8, 0x55566a, 0x55566a);
    for (const grid of [minor, major]) {
      grid.rotateX(Math.PI / 2);
      const mat = grid.material as THREE.LineBasicMaterial;
      mat.transparent = true;
      mat.opacity = 0.7;
      mat.depthWrite = false;
      g.add(grid);
    }
    const axes = new THREE.AxesHelper(60);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    axes.renderOrder = 1;
    g.add(axes);
    return g;
  }

  private buildAxisTriad(): void {
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xe5484d, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x46a758, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x3e8ef7, 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      this.axisScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.16));
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.font = 'bold 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 32, 34);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      sprite.position.copy(dir).multiplyScalar(1.38);
      sprite.scale.setScalar(0.5);
      this.axisScene.add(sprite);
    }
    this.axisCamera.up.set(0, 0, 1);
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    this.render();
  };

  private render(): void {
    this.orbit.update();
    const r = this.renderer;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    r.setViewport(0, 0, w, h);
    r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);

    // Axis triad in the bottom-left corner, turned with the main camera.
    const size = Math.min(110, Math.floor(Math.min(w, h) / 3));
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.axisCamera.position.copy(dir.multiplyScalar(5));
    this.axisCamera.up.copy(this.camera.up);
    this.axisCamera.lookAt(0, 0, 0);
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(8, 8, size, size);
    r.setViewport(8, 8, size, size);
    r.render(this.axisScene, this.axisCamera);
    r.setScissorTest(false);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.autosaveTimer);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.transform.detach();
    this.transform.dispose();
    this.orbit.dispose();
    for (const e of this.entries) this.disposeEntry(e);
    this.clearMeasure(false);
    this.renderer.dispose();
    canvas.remove();
  }

  // ---------------------------------------------------------------- state reporting

  private emitSoon(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    requestAnimationFrame(() => {
      this.emitQueued = false;
      this.emit();
    });
  }

  private emit(): void {
    if (this.disposed) return;
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const objects: ObjectInfo[] = this.entries.map(e => {
      const m = e.mesh;
      m.updateMatrixWorld(true);
      box.setFromObject(m).getSize(size);
      return {
        id: e.id,
        name: e.name,
        kind: e.kind,
        visible: e.visible,
        color: e.color,
        params: e.params ? { ...e.params } : null,
        position: vec(m.position).map(v => round(v, 3)) as Vec3,
        rotation: vec(m.rotation).map(v => round(THREE.MathUtils.radToDeg(v), 2)) as Vec3,
        scale: vec(m.scale).map(v => round(v, 4)) as Vec3,
        size: vec(size).map(v => round(v, 3)) as Vec3,
        triangles: e.triangles,
      };
    });
    this.onState({
      objects,
      selected: [...this.selected],
      mode: this.mode,
      tool: this.tool,
      snap: this.snap,
      wireframe: this.wireframe,
      grid: this.gridVisible,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      measurePoints: this.measurePoints.length,
      measure: this.measureResult,
      message: this.message,
    });
  }

  private say(text: string, kind: 'info' | 'error' = 'info'): void {
    this.message = { text, kind, at: Date.now() };
  }

  // ---------------------------------------------------------------- entries

  private nextId(): string {
    let id: string;
    do { id = 'o' + (++this.idCounter); } while (this.entries.some(e => e.id === id));
    return id;
  }

  // FreeCAD-style names: Box, Box001, Box002 ...
  private nextName(base: string): string {
    const names = new Set(this.entries.map(e => e.name));
    if (!names.has(base)) return base;
    for (let i = 1; ; i++) {
      const n = base + String(i).padStart(3, '0');
      if (!names.has(n)) return n;
    }
  }

  private createEntry(item: Omit<SnapItem, 'geometry'>, geometry: THREE.BufferGeometry): Entry {
    const material = new THREE.MeshStandardMaterial({
      color: item.color,
      metalness: 0.15,
      roughness: 0.55,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      wireframe: this.wireframe,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(item.position);
    mesh.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
    mesh.scale.fromArray(item.scale);
    mesh.visible = item.visible;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    edges.visible = !this.wireframe;
    mesh.add(edges);
    mesh.userData['id'] = item.id;
    const entry: Entry = {
      id: item.id, name: item.name, kind: item.kind, params: item.params ? { ...item.params } : null,
      mesh, edges, color: item.color, visible: item.visible, triangles: triangleCount(geometry),
    };
    this.entries.push(entry);
    this.root.add(mesh);
    return entry;
  }

  private disposeEntry(e: Entry): void {
    this.root.remove(e.mesh);
    // Feature geometry may still be referenced by history snapshots; only primitives own theirs.
    if (e.params) e.mesh.geometry.dispose();
    e.mesh.material.dispose();
    e.edges.geometry.dispose();
    e.edges.material.dispose();
  }

  private entry(id: string): Entry | undefined {
    return this.entries.find(e => e.id === id);
  }

  private setGeometry(e: Entry, g: THREE.BufferGeometry): void {
    if (e.params) e.mesh.geometry.dispose();
    e.mesh.geometry = g;
    e.edges.geometry.dispose();
    e.edges.geometry = new THREE.EdgesGeometry(g, 28);
    e.triangles = triangleCount(g);
  }

  private refreshHighlight(): void {
    for (const e of this.entries) {
      const sel = this.selected.includes(e.id);
      e.mesh.material.emissive.setHex(sel ? SELECT_EMISSIVE : 0x000000);
      e.edges.material.color.setHex(sel ? SELECT_EDGE_COLOR : EDGE_COLOR);
    }
    const primary = this.entry(this.selected[this.selected.length - 1] ?? '');
    if (primary && primary.visible && this.tool === 'select') {
      this.transform.attach(primary.mesh);
      this.transform.setMode(this.mode);
    } else {
      this.transform.detach();
    }
  }

  // ---------------------------------------------------------------- history

  private snapshot(): Snapshot {
    return {
      items: this.entries.map(e => ({
        id: e.id, name: e.name, kind: e.kind, params: e.params ? { ...e.params } : null,
        geometry: e.params ? null : e.mesh.geometry,
        color: e.color, visible: e.visible,
        position: vec(e.mesh.position), rotation: vec(e.mesh.rotation), scale: vec(e.mesh.scale),
      })),
      selected: [...this.selected],
    };
  }

  private restore(s: Snapshot): void {
    this.transform.detach();
    for (const e of this.entries) this.disposeEntry(e);
    this.entries = [];
    for (const item of s.items) {
      const g = item.geometry ?? buildPrimitive(item.kind as PrimitiveKind, item.params!);
      this.createEntry(item, g);
    }
    this.selected = s.selected.filter(id => this.entries.some(e => e.id === id));
    this.refreshHighlight();
  }

  // Records the scene as it is now as one undoable step.
  private commit(): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.current = this.snapshot();
    this.scheduleAutosave();
    this.emit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.current);
    this.current = prev;
    this.restore(prev);
    this.scheduleAutosave();
    this.say('Undo');
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.current);
    this.current = next;
    this.restore(next);
    this.scheduleAutosave();
    this.say('Redo');
    this.emit();
  }

  // ---------------------------------------------------------------- creating and editing

  addPrimitive(kind: PrimitiveKind): void {
    const spec = primitiveSpec(kind)!;
    const params = { ...spec.defaults };
    // Place the new shape just right of everything already in the document.
    const box = this.contentBox(false);
    const x = box.isEmpty() ? 0 : round(box.max.x + 10 + this.footprint(kind, params), 0);
    const e = this.createEntry({
      id: this.nextId(), name: this.nextName(kind), kind, params, color: DEFAULT_COLOR, visible: true,
      position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    }, buildPrimitive(kind, params));
    this.selected = [e.id];
    this.refreshHighlight();
    this.say(`${e.name} created`);
    this.commit();
  }

  private footprint(kind: PrimitiveKind, p: Params): number {
    switch (kind) {
      case 'Box': return p['length'] / 2;
      case 'Cylinder': case 'Sphere': return p['radius'];
      case 'Cone': return Math.max(p['radius1'], p['radius2']);
      case 'Torus': return p['radius'] + p['tube'];
      case 'Prism': return p['circumradius'];
      case 'Tube': return p['outerRadius'];
    }
  }

  select(id: string | null, additive = false): void {
    if (id === null) {
      this.selected = [];
    } else if (additive) {
      this.selected = this.selected.includes(id) ? this.selected.filter(s => s !== id) : [...this.selected, id];
    } else {
      this.selected = [id];
    }
    this.refreshHighlight();
    this.current.selected = [...this.selected];
    this.emit();
  }

  selectAll(): void {
    this.selected = this.entries.filter(e => e.visible).map(e => e.id);
    this.refreshHighlight();
    this.emit();
  }

  rename(id: string, name: string): void {
    const e = this.entry(id);
    const clean = name.trim().slice(0, 60);
    if (!e || !clean || clean === e.name) return;
    e.name = clean;
    this.commit();
  }

  setColor(id: string, color: string): void {
    const e = this.entry(id);
    if (!e || !/^#[0-9a-f]{6}$/i.test(color)) return;
    e.color = color;
    e.mesh.material.color.set(color);
    this.commit();
  }

  setVisible(id: string, visible: boolean): void {
    const e = this.entry(id);
    if (!e) return;
    e.visible = visible;
    e.mesh.visible = visible;
    if (!visible) this.selected = this.selected.filter(s => s !== id);
    this.refreshHighlight();
    this.commit();
  }

  toggleSelectedVisibility(): void {
    const sel = this.selected.map(id => this.entry(id)).filter((e): e is Entry => !!e);
    if (!sel.length) return;
    for (const e of sel) { e.visible = false; e.mesh.visible = false; }
    this.selected = [];
    this.refreshHighlight();
    this.commit();
  }

  showAll(): void {
    if (this.entries.every(e => e.visible)) return;
    for (const e of this.entries) { e.visible = true; e.mesh.visible = true; }
    this.commit();
  }

  setParam(id: string, key: string, value: number): void {
    const e = this.entry(id);
    const spec = e && primitiveSpec(e.kind);
    const p = spec?.params.find(s => s.key === key);
    if (!e || !e.params || !spec || !p || !Number.isFinite(value)) return;
    const v = p.integer ? Math.round(value) : value;
    if (v < p.min) {
      this.say(`${p.label} must be at least ${p.min}.`, 'error');
      this.emit();
      return;
    }
    const next = { ...e.params, [key]: v };
    const problem = spec.validate?.(next);
    if (problem) {
      this.say(problem, 'error');
      this.emit();
      return;
    }
    e.params = next;
    this.setGeometry(e, buildPrimitive(e.kind as PrimitiveKind, next));
    this.commit();
  }

  setPlacement(id: string, part: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, value: number): void {
    const e = this.entry(id);
    if (!e || !Number.isFinite(value)) return;
    if (part === 'position') {
      e.mesh.position.setComponent(axis, value);
    } else if (part === 'rotation') {
      const r = e.mesh.rotation;
      const v = THREE.MathUtils.degToRad(value);
      r.set(axis === 0 ? v : r.x, axis === 1 ? v : r.y, axis === 2 ? v : r.z);
    } else {
      if (Math.abs(value) < 0.001) {
        this.say('Scale cannot be 0.', 'error');
        this.emit();
        return;
      }
      e.mesh.scale.setComponent(axis, value);
    }
    this.commit();
  }

  // Drops the selected objects onto the grid (lowest point at Z = 0).
  dropToGrid(): void {
    const sel = this.selected.map(id => this.entry(id)).filter((e): e is Entry => !!e);
    if (!sel.length) return;
    const box = new THREE.Box3();
    for (const e of sel) {
      e.mesh.updateMatrixWorld(true);
      box.setFromObject(e.mesh);
      e.mesh.position.z -= box.min.z;
    }
    this.commit();
  }

  deleteSelected(): void {
    if (!this.selected.length) return;
    const n = this.selected.length;
    this.transform.detach();
    for (const id of this.selected) {
      const e = this.entry(id);
      if (!e) continue;
      this.disposeEntry(e);
      this.entries = this.entries.filter(x => x !== e);
    }
    this.selected = [];
    this.refreshHighlight();
    this.say(n === 1 ? 'Object deleted' : `${n} objects deleted`);
    this.commit();
  }

  duplicateSelected(): void {
    const sel = this.selected.map(id => this.entry(id)).filter((e): e is Entry => !!e);
    if (!sel.length) return;
    const box = new THREE.Box3();
    const created: string[] = [];
    for (const e of sel) {
      e.mesh.updateMatrixWorld(true);
      const width = box.setFromObject(e.mesh).getSize(new THREE.Vector3()).x;
      const g = e.params ? buildPrimitive(e.kind as PrimitiveKind, e.params) : e.mesh.geometry;
      const copy = this.createEntry({
        id: this.nextId(), name: this.nextName(e.name.replace(/\d{3}$/, '')), kind: e.kind, params: e.params,
        color: e.color, visible: true,
        position: [e.mesh.position.x + round(width + 5, 0), e.mesh.position.y, e.mesh.position.z],
        rotation: vec(e.mesh.rotation), scale: vec(e.mesh.scale),
      }, g);
      created.push(copy.id);
    }
    this.selected = created;
    this.refreshHighlight();
    this.say(created.length === 1 ? 'Object duplicated' : `${created.length} objects duplicated`);
    this.commit();
  }

  // ---------------------------------------------------------------- booleans

  boolean(op: BooleanOp): void {
    const sel = this.selected.map(id => this.entry(id)).filter((e): e is Entry => !!e && e.visible);
    if (sel.length < 2) {
      this.say('Select at least two visible objects (Ctrl/Shift + click) first.', 'error');
      this.emit();
      return;
    }
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = false;
    const toBrush = (e: Entry): Brush => {
      const g = e.mesh.geometry.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      }
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.clearGroups();
      const b = new Brush(g);
      b.position.copy(e.mesh.position);
      b.rotation.copy(e.mesh.rotation);
      b.scale.copy(e.mesh.scale);
      b.updateMatrixWorld(true);
      return b;
    };
    const csgOp = op === 'union' ? ADDITION : op === 'cut' ? SUBTRACTION : INTERSECTION;
    let result: Brush;
    try {
      result = toBrush(sel[0]);
      for (const e of sel.slice(1)) {
        result = evaluator.evaluate(result, toBrush(e), csgOp) as Brush;
        result.updateMatrixWorld(true);
      }
    } catch (err) {
      console.error('FuCad boolean failed', err);
      this.say('The boolean operation failed for these shapes.', 'error');
      this.emit();
      return;
    }
    const g = result.geometry;
    if (!g.getAttribute('position') || g.getAttribute('position').count === 0) {
      this.say(op === 'intersect' ? 'The shapes do not overlap: the intersection is empty.' : 'The result is empty.', 'error');
      this.emit();
      return;
    }
    const offset = rebaseGeometry(g);
    const kind: ObjectKind = op === 'union' ? 'Union' : op === 'cut' ? 'Cut' : 'Intersection';
    this.transform.detach();
    for (const e of sel) {
      this.disposeEntry(e);
      this.entries = this.entries.filter(x => x !== e);
    }
    const created = this.createEntry({
      id: this.nextId(), name: this.nextName(kind), kind, params: null, color: sel[0].color, visible: true,
      position: vec(offset), rotation: [0, 0, 0], scale: [1, 1, 1],
    }, g);
    this.selected = [created.id];
    this.refreshHighlight();
    this.say(`${created.name} created from ${sel.length} objects`);
    this.commit();
  }

  // ---------------------------------------------------------------- tools and view

  setMode(mode: TransformMode): void {
    this.mode = mode;
    if (this.tool !== 'select') this.setTool('select');
    this.transform.setMode(mode);
    this.emit();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool !== 'measure') this.clearMeasure(false);
    this.refreshHighlight();
    this.emit();
  }

  setSnap(on: boolean): void {
    this.snap = on;
    this.transform.setTranslationSnap(on ? 1 : null);
    this.transform.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    this.transform.setScaleSnap(on ? 0.1 : null);
    this.emit();
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    for (const e of this.entries) {
      e.mesh.material.wireframe = on;
      e.edges.visible = !on;
    }
    this.emit();
  }

  setGrid(on: boolean): void {
    this.gridVisible = on;
    this.grid.visible = on;
    this.emit();
  }

  private contentBox(selectionOnly: boolean): THREE.Box3 {
    const box = new THREE.Box3();
    const pool = selectionOnly && this.selected.length
      ? this.entries.filter(e => this.selected.includes(e.id))
      : this.entries;
    for (const e of pool) {
      if (!e.visible) continue;
      e.mesh.updateMatrixWorld(true);
      box.expandByObject(e.mesh);
    }
    return box;
  }

  fit(selectionOnly = false): void {
    let box = this.contentBox(selectionOnly);
    if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-40, -40, 0), new THREE.Vector3(40, 40, 30));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 500, 0.01);
    this.camera.far = dist * 200;
    this.camera.updateProjectionMatrix();
    this.orbit.update();
  }

  setView(view: ViewName): void {
    const dirs: Record<ViewName, THREE.Vector3> = {
      iso: new THREE.Vector3(1, -1, 0.8),
      front: new THREE.Vector3(0, -1, 0),
      back: new THREE.Vector3(0, 1, 0),
      top: new THREE.Vector3(0, -0.0001, 1),
      bottom: new THREE.Vector3(0, -0.0001, -1),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
    };
    const dist = this.camera.position.distanceTo(this.orbit.target);
    this.camera.position.copy(this.orbit.target).addScaledVector(dirs[view].normalize(), dist);
    this.fit();
  }

  // ---------------------------------------------------------------- picking and measuring

  private onPointerDown = (ev: PointerEvent): void => {
    this.pointerDown = { x: ev.clientX, y: ev.clientY };
  };

  private onPointerUp = (ev: PointerEvent): void => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (this.gizmoClick) {
      this.gizmoClick = false;
      return;
    }
    if (!start || ev.button !== 0 || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 5) return;
    const hit = this.pick(ev);
    if (this.tool === 'measure') {
      if (hit) this.addMeasurePoint(hit.point);
      return;
    }
    const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    if (hit) this.select(hit.object.userData['id'], additive);
    else if (!additive) this.select(null);
  };

  private onDoubleClick = (ev: MouseEvent): void => {
    const hit = this.pick(ev);
    if (hit && this.tool === 'select') {
      this.select(hit.object.userData['id']);
      this.fit(true);
    }
  };

  private pick(ev: MouseEvent): THREE.Intersection | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = this.entries.filter(e => e.visible).map(e => e.mesh);
    return this.raycaster.intersectObjects(meshes, false)[0];
  }

  private addMeasurePoint(p: THREE.Vector3): void {
    if (this.measurePoints.length >= 2) this.clearMeasure(false);
    this.measurePoints.push(p.clone());
    const radius = Math.max(this.camera.position.distanceTo(this.orbit.target) * 0.006, 0.05);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false }),
    );
    marker.renderOrder = 10;
    marker.position.copy(p);
    this.measureGroup.add(marker);
    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false }),
      );
      line.renderOrder = 10;
      this.measureGroup.add(line);
      this.measureResult = {
        distance: round(a.distanceTo(b), 3),
        dx: round(Math.abs(b.x - a.x), 3),
        dy: round(Math.abs(b.y - a.y), 3),
        dz: round(Math.abs(b.z - a.z), 3),
      };
    }
    this.emit();
  }

  clearMeasure(emit = true): void {
    for (const child of [...this.measureGroup.children]) {
      this.measureGroup.remove(child);
      const obj = child as THREE.Mesh | THREE.Line;
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
    this.measurePoints = [];
    this.measureResult = null;
    if (emit) this.emit();
  }

  // ---------------------------------------------------------------- documents

  newDocument(): void {
    this.transform.detach();
    for (const e of this.entries) this.disposeEntry(e);
    this.entries = [];
    this.selected = [];
    this.clearMeasure(false);
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.snapshot();
    this.scheduleAutosave();
    this.say('New document');
    this.fit();
    this.emit();
  }

  serialize(name: string): string {
    const objects: SavedObject[] = this.entries.map(e => {
      const base: SavedObject = {
        id: e.id, name: e.name, kind: e.kind, color: e.color, visible: e.visible,
        position: vec(e.mesh.position).map(v => round(v, 5)) as Vec3,
        rotation: vec(e.mesh.rotation).map(v => round(v, 6)) as Vec3,
        scale: vec(e.mesh.scale).map(v => round(v, 6)) as Vec3,
      };
      if (e.params) {
        base.params = { ...e.params };
      } else {
        const g = e.mesh.geometry.index ? e.mesh.geometry.toNonIndexed() : e.mesh.geometry;
        const pos = g.getAttribute('position');
        const nor = g.getAttribute('normal');
        base.mesh = {
          position: Array.from(pos.array as ArrayLike<number>, v => round(v)),
          normal: nor ? Array.from(nor.array as ArrayLike<number>, v => round(v, 3)) : undefined,
        };
      }
      return base;
    });
    return JSON.stringify({ format: FILE_FORMAT, version: 1, name, units: 'mm', objects });
  }

  // Loads a document saved by serialize(). Returns the document name, or throws with a readable message.
  load(json: string, fromAutosave = false): string {
    let data: { format?: unknown; name?: unknown; objects?: unknown };
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('This file is not a FuCad project.');
    }
    if (data?.format !== FILE_FORMAT || !Array.isArray(data.objects)) {
      throw new Error('This file is not a FuCad project.');
    }
    const items: SnapItem[] = [];
    for (const raw of data.objects as SavedObject[]) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string'
        || !isVec3(raw.position) || !isVec3(raw.rotation) || !isVec3(raw.scale)) continue;
      const spec = primitiveSpec(raw.kind);
      const item: SnapItem = {
        id: raw.id, name: raw.name.slice(0, 60), kind: raw.kind, params: null, geometry: null,
        color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : DEFAULT_COLOR, visible: raw.visible !== false,
        position: raw.position, rotation: raw.rotation, scale: raw.scale,
      };
      if (spec && raw.params) {
        const p: Params = { ...spec.defaults };
        for (const s of spec.params) {
          const v = raw.params[s.key];
          if (typeof v === 'number' && Number.isFinite(v) && v >= s.min) p[s.key] = v;
        }
        if (spec.validate?.(p)) continue;
        item.params = p;
      } else if (raw.mesh && Array.isArray(raw.mesh.position) && raw.mesh.position.length >= 9) {
        const g = new THREE.BufferGeometry();
        const count = raw.mesh.position.length - (raw.mesh.position.length % 9);
        g.setAttribute('position', new THREE.Float32BufferAttribute(raw.mesh.position.slice(0, count), 3));
        if (Array.isArray(raw.mesh.normal) && raw.mesh.normal.length >= count) {
          g.setAttribute('normal', new THREE.Float32BufferAttribute(raw.mesh.normal.slice(0, count), 3));
        } else {
          g.computeVertexNormals();
        }
        item.geometry = g;
        if (!(['Union', 'Cut', 'Intersection', 'Import'] as string[]).includes(raw.kind)) item.kind = 'Import';
      } else {
        continue;
      }
      items.push(item);
    }
    this.clearMeasure(false);
    this.restore({ items, selected: [] });
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.snapshot();
    if (!fromAutosave) {
      this.scheduleAutosave();
      this.say(`Opened ${items.length} object${items.length === 1 ? '' : 's'}`);
    }
    this.fit();
    this.emit();
    return typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0, 60) : 'Untitled';
  }

  private docName = 'Untitled';

  setDocumentName(name: string): void {
    this.docName = name;
    this.scheduleAutosave();
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, this.serialize(this.docName));
      } catch {
        // Storage full or blocked: the document still works, it just is not kept across visits.
      }
    }, 800);
  }

  // Returns the saved document name when an autosave was restored.
  restoredName: string | null = null;

  private loadAutosave(): boolean {
    let json: string | null = null;
    try {
      json = localStorage.getItem(AUTOSAVE_KEY);
    } catch {
      return false;
    }
    if (!json) return false;
    try {
      this.restoredName = this.load(json, true);
      this.docName = this.restoredName;
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- import / export

  async importFile(file: File): Promise<void> {
    const ext = file.name.toLowerCase().split('.').pop();
    let geometry: THREE.BufferGeometry | null = null;
    try {
      if (ext === 'stl') {
        geometry = new STLLoader().parse(await file.arrayBuffer());
      } else if (ext === 'obj') {
        const group = new OBJLoader().parse(await file.text());
        group.updateMatrixWorld(true);
        const parts: THREE.BufferGeometry[] = [];
        group.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
          if (g.index) g = g.toNonIndexed();
          const clean = new THREE.BufferGeometry();
          clean.setAttribute('position', g.getAttribute('position'));
          parts.push(clean);
        });
        geometry = parts.length ? mergeGeometries(parts, false) : null;
      } else {
        throw new Error('Choose an .stl or .obj file.');
      }
    } catch (err) {
      this.say(err instanceof Error && err.message.startsWith('Choose') ? err.message : `Could not read ${file.name}.`, 'error');
      this.emit();
      return;
    }
    if (!geometry || !geometry.getAttribute('position') || geometry.getAttribute('position').count < 3) {
      this.say(`${file.name} has no geometry.`, 'error');
      this.emit();
      return;
    }
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    const offset = rebaseGeometry(geometry);
    const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'Import';
    const e = this.createEntry({
      id: this.nextId(), name: this.nextName(base), kind: 'Import', params: null, color: DEFAULT_COLOR, visible: true,
      position: [offset.x, offset.y, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    }, geometry);
    this.selected = [e.id];
    this.refreshHighlight();
    this.say(`Imported ${file.name} (${e.triangles.toLocaleString()} triangles)`);
    this.commit();
    this.fit();
  }

  // Builds a throwaway group holding the visible (or selected) shapes with their placement baked in.
  private exportGroup(selectedOnly: boolean): THREE.Group | null {
    const pool = this.entries.filter(e => e.visible && (!selectedOnly || this.selected.includes(e.id)));
    if (!pool.length) return null;
    const group = new THREE.Group();
    for (const e of pool) {
      e.mesh.updateMatrixWorld(true);
      const m = new THREE.Mesh(e.mesh.geometry, e.mesh.material);
      m.name = e.name;
      m.applyMatrix4(e.mesh.matrixWorld);
      group.add(m);
    }
    group.updateMatrixWorld(true);
    return group;
  }

  exportSTL(selectedOnly: boolean): Blob | null {
    const group = this.exportGroup(selectedOnly);
    if (!group) return null;
    const data = new STLExporter().parse(group, { binary: true }) as DataView;
    return new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
  }

  exportOBJ(selectedOnly: boolean): Blob | null {
    const group = this.exportGroup(selectedOnly);
    if (!group) return null;
    return new Blob([new OBJExporter().parse(group)], { type: 'model/obj' });
  }

  // PNG of the current view on the workspace background (the canvas itself is transparent).
  screenshot(): string {
    this.render();
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d')!;
    const bg = ctx.createLinearGradient(0, 0, 0, out.height);
    bg.addColorStop(0, '#2a2b38');
    bg.addColorStop(1, '#121318');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    return out.toDataURL('image/png');
  }
}
