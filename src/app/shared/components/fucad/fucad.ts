import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, afterNextRender, computed, inject, signal, viewChild,
} from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { FucadEngine } from './fucad-engine';
import {
  BooleanOp, EngineMessage, EngineState, ObjectInfo, ObjectKind, PRIMITIVES, PrimitiveKind, Tool, TransformMode, ViewName, primitiveSpec,
} from './fucad-model';

// Stroke icons (24×24). Static strings, so marking them trusted is safe.
const ICONS: Record<string, string> = {
  new: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h13l3-9H7l-3 9"/>',
  save: '<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="8"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  export: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 8"/>',
  Box: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  Cylinder: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  Sphere: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/>',
  Cone: '<path d="M12 3 5 18"/><path d="m12 3 7 15"/><ellipse cx="12" cy="18" rx="7" ry="3"/>',
  Torus: '<ellipse cx="12" cy="12" rx="9.5" ry="6"/><path d="M8 12c1.2 1.4 6.8 1.4 8 0"/><path d="M9 11.2c1.5-.9 4.5-.9 6 0"/>',
  Prism: '<path d="M7 4h10l4 4-4 4H7L3 8z"/><path d="M3 8v8l4 4h10l4-4V8"/><path d="M7 12v8M17 12v8"/>',
  Tube: '<ellipse cx="12" cy="6" rx="7" ry="3"/><ellipse cx="12" cy="6" rx="3.5" ry="1.4"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  Union: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>',
  Cut: '<path d="M15 6a6 6 0 1 1 0 12"/><path d="M12 7.2A6 6 0 1 0 12 16.8 6 6 0 0 1 12 7.2z" fill="currentColor" fill-opacity=".25"/><circle cx="9" cy="12" r="6"/>',
  Intersection: '<circle cx="9" cy="12" r="6" stroke-dasharray="2 2"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 2"/><path d="M12 7.2a6 6 0 0 1 0 9.6 6 6 0 0 1 0-9.6z" fill="currentColor" fill-opacity=".45"/>',
  Import: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="m8 14 4 4 4-4"/><path d="M12 10v8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  duplicate: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  delete: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
  translate: '<path d="M12 2v20M2 12h20"/><path d="m9 5 3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  scale: '<path d="M14 3h7v7"/><path d="M21 3l-8 8"/><rect x="3" y="11" width="10" height="10" rx="1"/>',
  snap: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 3h4v8a2 2 0 0 0 4 0V3h4"/><path d="M6 7h4M14 7h4"/>',
  drop: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M3 21h18"/>',
  measure: '<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  iso: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  front: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 4l4 -2h14v14l-2 4" opacity=".4"/>',
  top: '<path d="M3 9 12 4l9 5-9 5z"/><path d="M3 9v6l9 5 9-5V9" opacity=".4"/>',
  right: '<path d="M9 3l10 4v14L9 17z"/><path d="M9 3 4 6v14l5-3" opacity=".4"/>',
  wireframe: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 21 16.5M21 7.5 3 16.5M12 3v18"/>',
  grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
};

const NAME_LIMIT = 60;

@Component({
  selector: 'app-fucad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fucad.html',
  styleUrl: './fucad.css',
})
export class Fucad {
  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
  private readonly sanitizer = inject(DomSanitizer);
  private engine: FucadEngine | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMessageAt = 0;

  readonly primitives = PRIMITIVES;
  readonly icons: Record<string, SafeHtml> = {};
  readonly axes = ['X', 'Y', 'Z'] as const;
  readonly axisIndex = [0, 1, 2] as const;

  readonly state = signal<EngineState | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly docName = signal('Untitled');
  readonly renamingId = signal<string | null>(null);
  readonly menu = signal<'file' | 'export' | null>(null);
  readonly toast = signal<EngineMessage | null>(null);
  readonly panelsOpen = signal(true);

  readonly objects = computed(() => this.state()?.objects ?? []);
  readonly selectedIds = computed(() => this.state()?.selected ?? []);
  readonly selectedObjects = computed(() => {
    const ids = this.selectedIds();
    return this.objects().filter(o => ids.includes(o.id));
  });
  readonly active = computed<ObjectInfo | null>(() => {
    const ids = this.selectedIds();
    const id = ids[ids.length - 1];
    return ids.length === 1 ? this.objects().find(o => o.id === id) ?? null : null;
  });
  readonly activeParams = computed(() => {
    const a = this.active();
    const spec = a ? primitiveSpec(a.kind) : undefined;
    return a?.params && spec ? spec.params.map(p => ({ spec: p, value: a.params![p.key] })) : [];
  });
  readonly totalTriangles = computed(() => this.objects().reduce((n, o) => n + o.triangles, 0));
  readonly hint = computed(() => {
    const s = this.state();
    if (!s) return '';
    if (s.tool === 'measure') {
      return s.measurePoints === 1 ? 'Measure: click the second point' : 'Measure: click a point on a shape';
    }
    if (!s.objects.length) return 'Add a shape from the Create toolbar, or import an STL/OBJ file';
    if (s.selected.length > 1) return `${s.selected.length} selected · Union, Cut or Intersect to combine them`;
    if (s.selected.length === 1) return 'Drag the gizmo to move · W move · E rotate · R scale · Ctrl/Shift+click to add to the selection';
    return 'Click a shape to select it · Drag to orbit · Right-drag to pan · Scroll to zoom';
  });

  constructor() {
    for (const [k, v] of Object.entries(ICONS)) {
      this.icons[k] = this.sanitizer.bypassSecurityTrustHtml(
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${v}</svg>`,
      );
    }

    // The 3D engine (three.js) loads only in the browser, after the page is on screen.
    afterNextRender(async () => {
      try {
        const { FucadEngine } = await import('./fucad-engine');
        this.engine = new FucadEngine(this.viewport().nativeElement, s => this.onState(s));
        if (this.engine.restoredName) this.docName.set(this.engine.restoredName);
      } catch (err) {
        console.error('FuCad failed to start', err);
        this.loadError.set('The 3D workspace could not start. Your browser or graphics driver may not support WebGL.');
      } finally {
        this.loading.set(false);
      }
    });

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.toastTimer);
      this.engine?.dispose();
      this.engine = null;
    });
  }

  private onState(s: EngineState): void {
    this.state.set(s);
    if (s.message && s.message.at !== this.lastMessageAt) {
      this.lastMessageAt = s.message.at;
      this.showToast(s.message);
    }
  }

  private showToast(m: EngineMessage): void {
    this.toast.set(m);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), m.kind === 'error' ? 5000 : 2500);
  }

  private notify(text: string, kind: 'info' | 'error' = 'info'): void {
    this.showToast({ text, kind, at: Date.now() });
  }

  // ---------------------------------------------------------------- toolbar actions

  add(kind: PrimitiveKind): void { this.engine?.addPrimitive(kind); }
  undo(): void { this.engine?.undo(); }
  redo(): void { this.engine?.redo(); }
  duplicate(): void { this.engine?.duplicateSelected(); }
  remove(): void { this.engine?.deleteSelected(); }
  dropToGrid(): void { this.engine?.dropToGrid(); }
  combine(op: BooleanOp): void { this.engine?.boolean(op); }
  setMode(m: TransformMode): void { this.engine?.setMode(m); }
  setView(v: ViewName): void { this.engine?.setView(v); }
  fit(): void { this.engine?.fit(this.selectedIds().length > 0); }
  showAll(): void { this.engine?.showAll(); }
  clearMeasure(): void { this.engine?.clearMeasure(); }

  toggleTool(t: Tool): void {
    const s = this.state();
    this.engine?.setTool(s?.tool === t ? 'select' : t);
  }
  toggleSnap(): void { this.engine?.setSnap(!this.state()?.snap); }
  toggleWireframe(): void { this.engine?.setWireframe(!this.state()?.wireframe); }
  toggleGrid(): void { this.engine?.setGrid(!this.state()?.grid); }

  toggleMenu(m: 'file' | 'export', ev: Event): void {
    ev.stopPropagation();
    this.menu.set(this.menu() === m ? null : m);
  }

  newDocument(): void {
    this.menu.set(null);
    if (this.objects().length && !confirm('Start a new document? Unsaved changes to the current one will be lost.')) return;
    this.engine?.newDocument();
    this.setDocName('Untitled');
  }

  setDocName(name: string): void {
    const clean = name.trim().slice(0, NAME_LIMIT) || 'Untitled';
    this.docName.set(clean);
    this.engine?.setDocumentName(clean);
  }

  private fileBase(): string {
    return this.docName().replace(/[\\/:*?"<>|]+/g, '').trim() || 'Untitled';
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  save(): void {
    this.menu.set(null);
    if (!this.engine) return;
    this.download(new Blob([this.engine.serialize(this.docName())], { type: 'application/json' }), `${this.fileBase()}.fucad`);
    this.notify('Project saved to your downloads');
  }

  async openProject(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    this.menu.set(null);
    if (!file || !this.engine) return;
    try {
      const name = this.engine.load(await file.text());
      this.setDocName(name);
    } catch (err) {
      this.notify(err instanceof Error ? err.message : 'Could not open this file.', 'error');
    }
  }

  async importModel(input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    this.menu.set(null);
    for (const f of files) await this.engine?.importFile(f);
  }

  export(format: 'stl' | 'obj'): void {
    this.menu.set(null);
    if (!this.engine) return;
    const selectedOnly = this.selectedIds().length > 0;
    const blob = format === 'stl' ? this.engine.exportSTL(selectedOnly) : this.engine.exportOBJ(selectedOnly);
    if (!blob) {
      this.notify('There is nothing visible to export.', 'error');
      return;
    }
    const suffix = selectedOnly ? '-selection' : '';
    this.download(blob, `${this.fileBase()}${suffix}.${format}`);
  }

  async exportImage(): Promise<void> {
    this.menu.set(null);
    if (!this.engine) return;
    const blob = await (await fetch(this.engine.screenshot())).blob();
    this.download(blob, `${this.fileBase()}.png`);
  }

  // ---------------------------------------------------------------- model tree

  selectRow(o: ObjectInfo, ev: MouseEvent): void {
    this.engine?.select(o.id, ev.ctrlKey || ev.metaKey || ev.shiftKey);
  }

  toggleVisible(o: ObjectInfo, ev: Event): void {
    ev.stopPropagation();
    this.engine?.setVisible(o.id, !o.visible);
  }

  startRename(o: ObjectInfo): void {
    this.renamingId.set(o.id);
    setTimeout(() => {
      const el = document.getElementById('fc-rename-' + o.id) as HTMLInputElement | null;
      el?.focus();
      el?.select();
    });
  }

  finishRename(o: ObjectInfo, value: string): void {
    if (this.renamingId() !== o.id) return;
    this.renamingId.set(null);
    this.engine?.rename(o.id, value);
  }

  // ---------------------------------------------------------------- properties

  rename(o: ObjectInfo, value: string): void { this.engine?.rename(o.id, value); }
  setColor(o: ObjectInfo, value: string): void { this.engine?.setColor(o.id, value); }

  setParam(o: ObjectInfo, key: string, input: HTMLInputElement): void {
    const v = input.valueAsNumber;
    if (!Number.isFinite(v)) {
      input.value = String(o.params?.[key] ?? '');
      return;
    }
    this.engine?.setParam(o.id, key, v);
  }

  setPlacement(o: ObjectInfo, part: 'position' | 'rotation' | 'scale', axis: 0 | 1 | 2, input: HTMLInputElement): void {
    const v = input.valueAsNumber;
    if (!Number.isFinite(v)) {
      input.value = String(o[part][axis]);
      return;
    }
    this.engine?.setPlacement(o.id, part, axis, v);
  }

  icon(kind: ObjectKind | string): SafeHtml {
    return this.icons[kind] ?? this.icons['Box'];
  }

  fmt(n: number, digits = 2): string {
    return Number.isFinite(n) ? String(Math.round(n * 10 ** digits) / 10 ** digits) : '–';
  }

  // ---------------------------------------------------------------- keyboard

  @HostListener('document:pointerdown', ['$event'])
  onDocPointer(ev: PointerEvent): void {
    if (this.menu() && !(ev.target as Element | null)?.closest?.('.fc-menu-wrap')) this.menu.set(null);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    const engine = this.engine;
    const t = ev.target as HTMLElement | null;
    if (!engine || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    let handled = true;
    if (mod && k === 'z' && !ev.shiftKey) engine.undo();
    else if (mod && (k === 'y' || (k === 'z' && ev.shiftKey))) engine.redo();
    else if (mod && k === 'd') engine.duplicateSelected();
    else if (mod && k === 'a') engine.selectAll();
    else if (mod && k === 's') this.save();
    else if (mod) handled = false;
    else if (k === 'w' || k === 'g') engine.setMode('translate');
    else if (k === 'e') engine.setMode('rotate');
    else if (k === 'r') engine.setMode('scale');
    else if (k === 'm') this.toggleTool('measure');
    else if (k === 'f') this.fit();
    else if (k === 'h' && ev.shiftKey) engine.showAll();
    else if (k === 'h') engine.toggleSelectedVisibility();
    else if (k === 'delete' || k === 'backspace') engine.deleteSelected();
    else if (k === 'escape') {
      if (this.state()?.tool === 'measure') engine.setTool('select');
      else engine.select(null);
    }
    // FreeCAD's standard view keys.
    else if (k === '0') engine.setView('iso');
    else if (k === '1') engine.setView('front');
    else if (k === '2') engine.setView('top');
    else if (k === '3') engine.setView('right');
    else if (k === '4') engine.setView('back');
    else if (k === '5') engine.setView('bottom');
    else if (k === '6') engine.setView('left');
    else handled = false;
    if (handled) ev.preventDefault();
  }
}
