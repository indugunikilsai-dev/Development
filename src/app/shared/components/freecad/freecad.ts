import { ChangeDetectionStrategy, Component, DestroyRef, computed, ElementRef, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { environment } from '../../../../environments/environment';

type Status = 'checking' | 'online' | 'offline' | 'unconfigured';
type Mode = 'open' | 'import';

interface Notice { kind: 'ok' | 'error' | 'info'; text: string }

// Events from FreeCAD's File menu (fucad-stream/bridge/PortalBridge/PortalBridgeGui.py).
type BridgeEvent =
  | { type: 'pick'; id: string; mode: Mode; document: string }
  | { type: 'saved' | 'download'; id: string; path: string; name: string; document: string };

// What the page is asking the user right now. A browser only shows a file picker or save dialog
// in answer to a click on this page, so every request from FreeCAD becomes one click here.
type Prompt =
  | { kind: 'pick'; mode: Mode; document: string }
  | { kind: 'save'; eventId: string; path: string; name: string; handle?: FileHandle }
  | { kind: 'download'; eventId: string; name: string };

interface UploadResult { opened: boolean; document?: string; file?: string; error?: string }

// The File System Access API (Chrome, Edge): lets the page write back to the very file a design
// was opened from. Other browsers fall back to a file input and a normal download.
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface PickerType { description: string; accept: Record<string, string[]> }
interface FsWindow {
  showOpenFilePicker?(o: { types?: PickerType[]; excludeAcceptAllOption?: boolean; multiple?: boolean }): Promise<FileHandle[]>;
  showSaveFilePicker?(o: { suggestedName?: string; types?: PickerType[] }): Promise<FileHandle>;
}

// Formats FreeCAD opens. The file service and FreeCAD check again on their side.
const IMPORT_TYPES = [
  'fcstd', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', 'ply', 'off', 'amf',
  '3mf', 'dxf', 'dwg', 'svg', 'ifc', 'dae', 'gltf', 'glb', 'wrl', 'vrml', 'csg', 'scad',
];
const UPLOAD_MAX_MB = 200;

// FreeCAD (or FuCad) running in the fucad-stream container, shown here through its web desktop.
//
// Its File menu works with this PC: Open / Import show the PC's file picker, Save / Save As / Save
// a Copy / Export save on the PC. FreeCAD reports those menu commands through the container's file
// service (fucadFilesUrl), which this page listens to.
@Component({
  selector: 'app-freecad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './freecad.html',
  styleUrl: './freecad.css',
})
export class Freecad {
  private readonly frameHost = viewChild<ElementRef<HTMLElement>>('frameHost');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private readonly fs: FsWindow = typeof window !== 'undefined' ? window as unknown as FsWindow : {};

  // PC files that designs were opened from or saved to, by the document's file in the container.
  // A later File > Save in FreeCAD writes straight back to the same PC file.
  private readonly pcFiles = new Map<string, FileHandle>();
  private readonly writes = new Map<string, Promise<void>>();
  private inputMode: { mode: Mode; document: string } = { mode: 'open', document: '' };

  readonly streamUrl: string = environment.fucadStreamUrl;
  readonly filesUrl: string = (environment.fucadFilesUrl ?? '').replace(/\/+$/, '');
  readonly safeUrl: SafeResourceUrl | null;
  readonly status = signal<Status>(this.streamUrl ? 'checking' : 'unconfigured');
  readonly frameKey = signal(0);
  readonly mixedContent: boolean;

  readonly accept = IMPORT_TYPES.map(t => '.' + t).join(',');
  readonly busy = signal(false);
  readonly notice = signal<Notice | null>(null);
  readonly prompts = signal<Prompt[]>([]);
  readonly prompt = computed(() => this.prompts()[0] ?? null);
  readonly filesReady = computed(() => !!this.filesUrl && this.status() === 'online');
  readonly canWriteBack = !!this.fs.showSaveFilePicker;
  readonly askFullscreen = signal(false);
  readonly isFullscreen = signal(typeof document !== 'undefined' && !!document.fullscreenElement);
  private exitedByButton = false;

  constructor() {
    // The URL comes from the build's environment file, never from user input.
    this.safeUrl = this.streamUrl ? inject(DomSanitizer).bypassSecurityTrustResourceUrl(this.streamUrl) : null;
    this.mixedContent = typeof location !== 'undefined'
      && location.protocol === 'https:' && this.streamUrl.startsWith('http:');

    afterNextRender(() => {
      this.check();
      if (this.filesUrl) this.listen();
      this.fullscreenByDefault();
      document.addEventListener('fullscreenchange', () => this.onFullscreenChange(), { signal: this.abort.signal });
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.retryTimer);
      clearTimeout(this.noticeTimer);
      this.abort.abort();
      (navigator as Navigator & { keyboard?: { unlock?(): void } }).keyboard?.unlock?.();
    });
  }

  // Reachability probe: an opaque no-cors request succeeds when the stream server answers at all.
  async check(): Promise<void> {
    clearTimeout(this.retryTimer);
    if (!this.streamUrl) return;
    this.status.set('checking');
    try {
      await fetch(this.streamUrl, { mode: 'no-cors', cache: 'no-store' });
      this.status.set('online');
    } catch {
      this.status.set('offline');
      // Keep checking quietly so the page connects by itself once the container is up.
      this.retryTimer = setTimeout(() => this.check(), 10000);
    }
  }

  reload(): void {
    this.frameKey.update(k => k + 1);
    this.check();
  }

  fullscreen(): void {
    this.frameHost()?.nativeElement.requestFullscreen?.().catch(() => {});
  }

  exitFullscreen(): void {
    if (!document.fullscreenElement) return;
    this.exitedByButton = true;
    document.exitFullscreen().catch(() => { this.exitedByButton = false; });
  }

  // In full screen, Esc goes to FreeCAD (cancel a command, close a dialog) instead of leaving full
  // screen; holding Esc down still leaves it. Keyboard Lock: Chrome and Edge; other browsers keep
  // the normal Esc.
  private lockEscape(): void {
    const keyboard = (navigator as Navigator & {
      keyboard?: { lock?(keys?: string[]): Promise<void>; unlock?(): void };
    }).keyboard;
    if (document.fullscreenElement === this.frameHost()?.nativeElement) {
      keyboard?.lock?.(['Escape']).catch(() => {});
    } else {
      keyboard?.unlock?.();
    }
  }

  private onFullscreenChange(): void {
    this.lockEscape();
    // Left full screen: a dialog asks to go back; its OK click is the user action browsers need.
    const inFullscreen = !!document.fullscreenElement;
    this.isFullscreen.set(inFullscreen);
    // Left with the "Exit full screen" button: the user chose that, so no dialog.
    this.askFullscreen.set(!inFullscreen && !this.exitedByButton);
    if (inFullscreen) this.exitedByButton = false;
  }

  // OK in the "Switch to full screen" dialog.
  confirmFullscreen(): void {
    this.askFullscreen.set(false);
    this.frameHost()?.nativeElement.requestFullscreen?.().catch(() => this.askFullscreen.set(true));
  }

  // FreeCAD opens in full screen. Browsers allow that only right after a user action: opening this
  // page from a link still counts, so it goes full screen at once. Otherwise (page reloaded, URL
  // typed) the "Switch to full screen" dialog asks for that click.
  private fullscreenByDefault(): void {
    const host = this.frameHost()?.nativeElement;
    if (!host?.requestFullscreen || document.fullscreenElement) return;
    host.requestFullscreen().catch(() => this.askFullscreen.set(true));
  }

  // ---- FreeCAD's File menu events ----------------------------------------------------------------

  // Long-polls the file service. While this runs, FreeCAD routes its File menu to this PC; without
  // it (stream opened on its own) FreeCAD keeps its normal dialogs.
  private async listen(): Promise<void> {
    let cursor: string | null = null;
    while (!this.abort.signal.aborted) {
      if (!this.filesReady()) {
        cursor = null;
        await this.sleep(3000);
        continue;
      }
      try {
        const query: string = cursor === null ? '' : `?after=${encodeURIComponent(cursor)}`;
        const res = await fetch(`${this.filesUrl}/events${query}`, { cache: 'no-store', signal: this.abort.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json() as { cursor: string; events: BridgeEvent[] };
        if (cursor !== null) data.events.forEach(e => this.onEvent(e));
        cursor = data.cursor;
      } catch {
        if (this.abort.signal.aborted) return;
        cursor = null;
        await this.sleep(5000);
      }
    }
  }

  private async onEvent(e: BridgeEvent): Promise<void> {
    if (e.type === 'pick') {
      this.enqueue({ kind: 'pick', mode: e.mode, document: e.document }, p => p.kind === 'pick');
    } else if (e.type === 'download' && e.name.toLowerCase().endsWith('.pdf')) {
      // File > Export PDF: straight to the Downloads folder, no dialog.
      await this.downloadEvent(e.id, e.name);
    } else if (e.type === 'download') {
      this.enqueue({ kind: 'download', eventId: e.id, name: e.name });
    } else {
      const handle = this.pcFiles.get(e.path);
      if (handle && await this.permitted(handle, false)) {
        // Saved before (or opened) from this PC and allowed to write: no question to ask.
        this.writeBack(e.path, handle, e.id);
      } else {
        this.enqueue({ kind: 'save', eventId: e.id, path: e.path, name: e.name, handle },
                     p => p.kind === 'save' && p.path === e.path);
      }
    }
  }

  // ---- the prompt's buttons (each runs on a click, so the browser allows its dialog) ------------

  async confirm(p: Prompt): Promise<void> {
    if (p.kind === 'pick') {
      this.dismiss(p);
      return this.pickFromPc(p.mode, p.document);
    }
    if (p.kind === 'save' && p.handle) {
      // Same PC file as before: ask once for permission to write to it.
      const ok = await this.permitted(p.handle, true);
      if (ok) {
        this.dismiss(p);
        this.pcFiles.set(p.path, p.handle);
        return this.writeBack(p.path, p.handle, p.eventId);
      }
      return this.show('error', `Writing to ${p.handle.name} was not allowed. Use "Save as…" to choose a file.`);
    }
    return this.saveAs(p);
  }

  async saveAs(p: Prompt): Promise<void> {
    if (p.kind === 'pick') return;
    const name = p.kind === 'save' && p.handle ? p.handle.name : p.name;
    if (!this.fs.showSaveFilePicker) {
      this.dismiss(p);
      return this.downloadEvent(p.eventId, name);
    }
    let handle: FileHandle;
    try {
      handle = await this.fs.showSaveFilePicker({ suggestedName: name, types: this.typesFor(name) });
    } catch (e) {
      if (this.cancelled(e)) return;   // the prompt stays, so the user can try again
      throw e;
    }
    this.dismiss(p);
    if (p.kind === 'save') this.pcFiles.set(p.path, handle);
    await this.writeBack(p.kind === 'save' ? p.path : '', handle, p.eventId);
  }

  dismiss(p: Prompt): void {
    this.prompts.update(list => list.filter(x => x !== p));
  }

  // ---- Open / Import from this PC ---------------------------------------------------------------

  openFromPc(): void {
    this.pickFromPc('open', '');
  }

  importFromPc(): void {
    this.pickFromPc('import', '');
  }

  private async pickFromPc(mode: Mode, document: string): Promise<void> {
    if (this.busy()) return;
    if (!this.fs.showOpenFilePicker) {
      this.inputMode = { mode, document };
      this.fileInput()?.nativeElement.click();
      return;
    }
    let handle: FileHandle;
    try {
      [handle] = await this.fs.showOpenFilePicker({
        types: [{ description: 'CAD files', accept: { 'application/octet-stream': IMPORT_TYPES.map(t => '.' + t) } }],
        excludeAcceptAllOption: false,
      });
    } catch (e) {
      if (!this.cancelled(e)) this.show('error', this.describe(e, 'Could not open the file picker.'));
      return;
    }
    await this.upload(await handle.getFile(), mode, document, handle);
  }

  onFileChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';  // choosing the same file again must fire "change" again
    if (file) this.upload(file, this.inputMode.mode, this.inputMode.document);
  }

  private async upload(file: File, mode: Mode, document: string, handle?: FileHandle): Promise<void> {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
    if (!IMPORT_TYPES.includes(ext)) {
      return this.show('error', `FreeCAD cannot open .${ext || '?'} files. Supported: ${IMPORT_TYPES.join(', ')}.`);
    }
    if (file.size === 0 || file.size > UPLOAD_MAX_MB * 1024 * 1024) {
      return this.show('error', `The file must be smaller than ${UPLOAD_MAX_MB} MB.`);
    }

    this.busy.set(true);
    this.show('info', `${mode === 'import' ? 'Importing' : 'Opening'} ${file.name}…`, false);
    try {
      const query = `name=${encodeURIComponent(file.name)}&mode=${mode}&document=${encodeURIComponent(document)}`;
      const res = await fetch(`${this.filesUrl}/upload?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => ({})) as Partial<UploadResult>;
      if (!res.ok) throw new Error(data.error || `Opening failed (${res.status})`);
      if (!data.opened) throw new Error(data.error || 'FreeCAD could not open the file.');

      // A design opened from the PC is saved back to the same PC file.
      if (mode === 'open' && ext === 'fcstd' && handle && data.file) this.pcFiles.set(data.file, handle);
      this.show('ok', mode === 'import'
        ? `${file.name} was imported into ${data.document || 'the design'}.`
        : `${file.name} is open in FreeCAD.`);
    } catch (e) {
      this.show('error', this.describe(e, 'Opening failed.'));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- Save to this PC --------------------------------------------------------------------------

  async save(as = false): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      // FreeCAD saves, then reports it as a File menu event; the PC side is handled there.
      const res = await fetch(`${this.filesUrl}/save?as=${as ? 1 : 0}`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `Saving failed (${res.status})`);
      }
    } catch (e) {
      this.show('error', this.describe(e, 'Saving failed.'));
    } finally {
      this.busy.set(false);
    }
  }

  // Writes are queued per document, so two quick saves never interleave in one file.
  private writeBack(path: string, handle: FileHandle, eventId: string): Promise<void> {
    const key = path || eventId;
    const next = (this.writes.get(key) ?? Promise.resolve()).then(async () => {
      try {
        const blob = await this.fetchEventFile(eventId);
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        this.show('ok', `Saved to your PC: ${handle.name}`);
      } catch (e) {
        this.show('error', this.describe(e, `Could not save ${handle.name} on your PC.`));
      }
    });
    this.writes.set(key, next);
    return next;
  }

  private async downloadEvent(eventId: string, name: string): Promise<void> {
    try {
      const blob = await this.fetchEventFile(eventId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      this.show('ok', `${name} was saved to your Downloads folder.`);
    } catch (e) {
      this.show('error', this.describe(e, `Could not save ${name}.`));
    }
  }

  private async fetchEventFile(eventId: string): Promise<Blob> {
    const res = await fetch(`${this.filesUrl}/file?event=${encodeURIComponent(eventId)}`, { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(data.error || `Download failed (${res.status})`);
    }
    return res.blob();
  }

  // ---- helpers -----------------------------------------------------------------------------------

  promptTitle(p: Prompt): string {
    if (p.kind === 'pick') return p.mode === 'import' ? 'Import a file from your PC' : 'Open a file from your PC';
    if (p.kind === 'download') return `Save ${p.name} on your PC`;
    return p.handle ? `Save changes to ${p.handle.name}` : `Save ${p.name} on your PC`;
  }

  promptText(p: Prompt): string {
    if (p.kind === 'pick') {
      return p.mode === 'import'
        ? 'FreeCAD wants to import a file into the open design. Choose it on your PC.'
        : 'FreeCAD wants to open a design. Choose it on your PC.';
    }
    if (p.kind === 'save' && p.handle) {
      return `Your browser asks once whether this page may write to ${p.handle.name}. After that, File › Save in FreeCAD saves to it directly.`;
    }
    return this.canWriteBack
      ? 'Choose the folder and file name on your PC.' + (p.kind === 'save' ? ' Later saves in FreeCAD go to the same file.' : '')
      : 'The file is saved in your Downloads folder.';
  }

  confirmLabel(p: Prompt): string {
    if (p.kind === 'pick') return 'Choose file…';
    if (p.kind === 'save' && p.handle) return 'Save';
    return this.canWriteBack ? 'Choose where to save…' : 'Download';
  }

  dismissNotice(): void {
    clearTimeout(this.noticeTimer);
    this.notice.set(null);
  }

  private enqueue(p: Prompt, replaces?: (q: Prompt) => boolean): void {
    this.prompts.update(list => [...(replaces ? list.filter(q => !replaces(q)) : list), p]);
  }

  private async permitted(handle: FileHandle, ask: boolean): Promise<boolean> {
    try {
      if (!handle.queryPermission) return true;
      if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
      return ask && !!handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
    } catch {
      return false;
    }
  }

  private typesFor(name: string): PickerType[] | undefined {
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    if (!/^[a-z0-9]{1,10}$/.test(ext)) return undefined;
    return [{ description: ext === 'fcstd' ? 'FreeCAD design' : ext.toUpperCase() + ' file',
              accept: { 'application/octet-stream': ['.' + ext] } }];
  }

  private cancelled(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private show(kind: Notice['kind'], text: string, autoHide = kind === 'ok'): void {
    clearTimeout(this.noticeTimer);
    this.notice.set({ kind, text });
    if (autoHide) this.noticeTimer = setTimeout(() => this.notice.set(null), 6000);
  }

  private describe(e: unknown, fallback: string): string {
    // fetch rejects with a TypeError when the service cannot be reached at all.
    if (e instanceof TypeError) return 'The FreeCAD file service is not reachable. Is the container running?';
    return e instanceof Error && e.message ? e.message : fallback;
  }
}
