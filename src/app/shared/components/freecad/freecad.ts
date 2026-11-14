import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { environment } from '../../../../environments/environment';

type Status = 'checking' | 'online' | 'offline' | 'unconfigured';

// The real FuCad desktop application (D:\devo\FuCad), running in the fucad-stream container and
// shown here through its web desktop client. Nothing of FuCad is re-implemented in the portal.
@Component({
  selector: 'app-freecad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './freecad.html',
  styleUrl: './freecad.css',
})
export class Freecad {
  private readonly frameHost = viewChild<ElementRef<HTMLElement>>('frameHost');
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  readonly streamUrl: string = environment.fucadStreamUrl;
  readonly safeUrl: SafeResourceUrl | null;
  readonly status = signal<Status>(this.streamUrl ? 'checking' : 'unconfigured');
  readonly frameKey = signal(0);
  readonly mixedContent: boolean;

  constructor() {
    // The URL comes from the build's environment file, never from user input.
    this.safeUrl = this.streamUrl ? inject(DomSanitizer).bypassSecurityTrustResourceUrl(this.streamUrl) : null;
    this.mixedContent = typeof location !== 'undefined'
      && location.protocol === 'https:' && this.streamUrl.startsWith('http:');

    afterNextRender(() => this.check());
    inject(DestroyRef).onDestroy(() => clearTimeout(this.retryTimer));
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
}
