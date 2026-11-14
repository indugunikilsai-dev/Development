import * as THREE from 'three';
import { ADDITION, Brush, Evaluator, INTERSECTION, SUBTRACTION } from 'three-bvh-csg';
import { buildPrimitive } from './fucad-engine';
import { PRIMITIVES, PrimitiveKind } from './fucad-model';

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

function brush(kind: PrimitiveKind, params: Record<string, number>, at: [number, number, number] = [0, 0, 0]): Brush {
  const b = new Brush(buildPrimitive(kind, params));
  b.position.set(...at);
  b.updateMatrixWorld(true);
  return b;
}

describe('FuCad primitives', () => {
  for (const spec of PRIMITIVES) {
    it(`${spec.kind} stands on the grid with only position and normal`, () => {
      const g = buildPrimitive(spec.kind, spec.defaults);
      const b = bounds(g);
      expect(b.min.z).toBeCloseTo(0, 5);
      expect(b.max.z).toBeGreaterThan(0);
      expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position']);
      expect(g.groups.length).toBe(0);
    });
  }

  it('builds a box with the given length, width and height', () => {
    const size = bounds(buildPrimitive('Box', { length: 30, width: 20, height: 10 })).getSize(new THREE.Vector3());
    expect([size.x, size.y, size.z]).toEqual([30, 20, 10]);
  });

  it('points cylinders along Z', () => {
    const size = bounds(buildPrimitive('Cylinder', { radius: 5, height: 40 })).getSize(new THREE.Vector3());
    expect(size.z).toBeCloseTo(40, 5);
    expect(size.x).toBeCloseTo(10, 1);
  });

  it('rejects impossible shapes', () => {
    const tube = PRIMITIVES.find(p => p.kind === 'Tube')!;
    const torus = PRIMITIVES.find(p => p.kind === 'Torus')!;
    expect(tube.validate!({ outerRadius: 5, innerRadius: 6, height: 10 })).toBeTruthy();
    expect(torus.validate!({ radius: 3, tube: 4 })).toBeTruthy();
    expect(tube.validate!(tube.defaults)).toBeNull();
  });
});

describe('FuCad booleans', () => {
  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];
  evaluator.useGroups = false;

  it('cuts a hole through a box', () => {
    const box = brush('Box', { length: 20, width: 20, height: 10 });
    const hole = brush('Cylinder', { radius: 4, height: 30 }, [0, 0, -10]);
    const result = evaluator.evaluate(box, hole, SUBTRACTION) as Brush;
    const size = bounds(result.geometry).getSize(new THREE.Vector3());
    expect(result.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(size.x).toBeCloseTo(20, 3);
    expect(size.z).toBeCloseTo(10, 3);
  });

  it('unions two boxes into one longer body', () => {
    const a = brush('Box', { length: 10, width: 10, height: 10 });
    const b = brush('Box', { length: 10, width: 10, height: 10 }, [8, 0, 0]);
    const result = evaluator.evaluate(a, b, ADDITION) as Brush;
    expect(bounds(result.geometry).getSize(new THREE.Vector3()).x).toBeCloseTo(18, 3);
  });

  it('intersects to the overlapping part only', () => {
    const a = brush('Box', { length: 10, width: 10, height: 10 });
    const b = brush('Box', { length: 10, width: 10, height: 10 }, [6, 0, 0]);
    const result = evaluator.evaluate(a, b, INTERSECTION) as Brush;
    expect(bounds(result.geometry).getSize(new THREE.Vector3()).x).toBeCloseTo(4, 3);
  });
});
