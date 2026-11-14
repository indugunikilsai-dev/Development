// Shared shapes and types for the FuCad workspace. Kept free of three.js so the page component
// can import it without pulling the 3D engine into the server render.

export type PrimitiveKind = 'Box' | 'Cylinder' | 'Sphere' | 'Cone' | 'Torus' | 'Prism' | 'Tube';
export type FeatureKind = 'Union' | 'Cut' | 'Intersection' | 'Import';
export type ObjectKind = PrimitiveKind | FeatureKind;
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type Tool = 'select' | 'measure';
export type BooleanOp = 'union' | 'cut' | 'intersect';
export type ViewName = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left';
export type Vec3 = [number, number, number];
export type Params = Record<string, number>;

export interface ParamSpec {
  key: string;
  label: string;
  min: number;
  integer?: boolean;
}

export interface PrimitiveSpec {
  kind: PrimitiveKind;
  params: ParamSpec[];
  defaults: Params;
  // Returns an error message when the combination of values cannot form a solid.
  validate?: (p: Params) => string | null;
}

// Every dimension is in millimetres; every shape stands on the XY plane with Z up (as in FreeCAD).
export const PRIMITIVES: PrimitiveSpec[] = [
  {
    kind: 'Box',
    params: [
      { key: 'length', label: 'Length (X)', min: 0.01 },
      { key: 'width', label: 'Width (Y)', min: 0.01 },
      { key: 'height', label: 'Height (Z)', min: 0.01 },
    ],
    defaults: { length: 20, width: 20, height: 20 },
  },
  {
    kind: 'Cylinder',
    params: [
      { key: 'radius', label: 'Radius', min: 0.01 },
      { key: 'height', label: 'Height', min: 0.01 },
    ],
    defaults: { radius: 10, height: 20 },
  },
  {
    kind: 'Sphere',
    params: [{ key: 'radius', label: 'Radius', min: 0.01 }],
    defaults: { radius: 10 },
  },
  {
    kind: 'Cone',
    params: [
      { key: 'radius1', label: 'Bottom radius', min: 0 },
      { key: 'radius2', label: 'Top radius', min: 0 },
      { key: 'height', label: 'Height', min: 0.01 },
    ],
    defaults: { radius1: 10, radius2: 0, height: 20 },
    validate: p => (p['radius1'] <= 0 && p['radius2'] <= 0 ? 'At least one radius must be greater than 0.' : null),
  },
  {
    kind: 'Torus',
    params: [
      { key: 'radius', label: 'Ring radius', min: 0.01 },
      { key: 'tube', label: 'Tube radius', min: 0.01 },
    ],
    defaults: { radius: 12, tube: 4 },
    validate: p => (p['tube'] >= p['radius'] ? 'Tube radius must be smaller than the ring radius.' : null),
  },
  {
    kind: 'Prism',
    params: [
      { key: 'sides', label: 'Sides', min: 3, integer: true },
      { key: 'circumradius', label: 'Circumradius', min: 0.01 },
      { key: 'height', label: 'Height', min: 0.01 },
    ],
    defaults: { sides: 6, circumradius: 10, height: 20 },
  },
  {
    kind: 'Tube',
    params: [
      { key: 'outerRadius', label: 'Outer radius', min: 0.01 },
      { key: 'innerRadius', label: 'Inner radius', min: 0.01 },
      { key: 'height', label: 'Height', min: 0.01 },
    ],
    defaults: { outerRadius: 10, innerRadius: 6, height: 20 },
    validate: p => (p['innerRadius'] >= p['outerRadius'] ? 'Inner radius must be smaller than the outer radius.' : null),
  },
];

export function primitiveSpec(kind: string): PrimitiveSpec | undefined {
  return PRIMITIVES.find(p => p.kind === kind);
}

export interface ObjectInfo {
  id: string;
  name: string;
  kind: ObjectKind;
  visible: boolean;
  color: string;
  params: Params | null;
  position: Vec3;
  rotation: Vec3; // degrees
  scale: Vec3;
  size: Vec3; // world bounding-box size
  triangles: number;
}

export interface MeasureResult {
  distance: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface EngineMessage {
  text: string;
  kind: 'info' | 'error';
  at: number;
}

export interface EngineState {
  objects: ObjectInfo[];
  selected: string[];
  mode: TransformMode;
  tool: Tool;
  snap: boolean;
  wireframe: boolean;
  grid: boolean;
  canUndo: boolean;
  canRedo: boolean;
  measurePoints: number;
  measure: MeasureResult | null;
  message: EngineMessage | null;
}
