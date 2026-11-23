import { EventEmitter } from 'node:events';
import { BrowserWindow, WebContentsView, session, type IpcMainInvokeEvent } from 'electron';
import { TOOLBAR_HEIGHT, type ShellState, type SiteId } from '../shared/types';
import { isDlpDocument, isNavigationAllowed, SITE_CONFIG_ARG, type SiteDef } from './sites';

/** One persistent profile shared by both sites, so logins survive restarts. */
export const SITE_PARTITION = 'persist:walled-sites';

/** User agent used by the Perplexity view. */
function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0];
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Permissions a chat site legitimately needs. Everything else (camera, mic, geolocation...) is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * Owns the embedded browser views (one Electron WebContentsView per site), keeps them laid out below
 * the toolbar, and enforces what website content may do. Emits `state` whenever the toolbar must update.
 */
export class SiteViews extends EventEmitter {
  private readonly views = new Map<SiteId, WebContentsView>();
  private active: SiteId;
  private scanEpoch = 0;

  constructor(
    private readonly win: BrowserWindow,
    private readonly sites: Record<SiteId, SiteDef>,
    private readonly preloadPath: string,
    private readonly openExternal: (url: string) => void,
  ) {
    super();
    this.active = 'chatgpt';
    this.configureSession();
    for (const ev of ['resize', 'resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.on(ev as 'resize', () => this.layout());
    }
  }

  // ---------------------------------------------------------------- public
  select(id: SiteId): void {
    if (!this.sites[id]) throw new Error(`unknown site: ${id}`);
    if (this.active !== id) this.scanEpoch += 1;
    this.active = id;
    let view = this.views.get(id);
    if (!view) {
      view = this.createView(this.sites[id]);
      this.views.set(id, view);
      this.win.contentView.addChildView(view);
      this.load(view, this.sites[id].url);
    }
    for (const [key, v] of this.views) v.setVisible(key === id);
    this.layout();
    this.emitState();
  }

  goBack(): void {
    const h = this.current()?.webContents.navigationHistory;
    if (h?.canGoBack()) h.goBack();
  }

  goForward(): void {
    const h = this.current()?.webContents.navigationHistory;
    if (h?.canGoForward()) h.goForward();
  }

  reload(): void {
    const view = this.current();
    if (view) view.webContents.reload();
    else this.select(this.active);
  }

  get inspectionEpoch(): number {
    return this.scanEpoch;
  }

  scanSite(event: IpcMainInvokeEvent): SiteDef | undefined {
    const frame = event.senderFrame;
    const site = this.sites[this.active];
    if (frame && event.sender === this.current()?.webContents && !event.sender.isDestroyed()
      && frame === event.sender.mainFrame && isDlpDocument(site, frame.url)) {
      return site;
    }
    return undefined;
  }

  getState(): ShellState {
    const wc = this.current()?.webContents;
    return {
      sites: Object.values(this.sites).map((s) => ({ id: s.id, name: s.name })),
      active: this.active,
      url: wc?.getURL() ?? '',
      title: wc?.getTitle() ?? '',
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    };
  }

  /** Test / diagnostics access. */
  get all(): ReadonlyMap<SiteId, WebContentsView> {
    return this.views;
  }

  dispose(): void {
    const views = [...this.views.values()];
    this.views.clear();
    this.scanEpoch += 1;
    for (const view of views) {
      if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  // --------------------------------------------------------------- internals
  private current(): WebContentsView | undefined {
    return this.views.get(this.active);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private load(view: WebContentsView, url: string): void {
    void view.webContents.loadURL(url).catch((error: { code?: string }) => {
      if (!view.webContents.isDestroyed() && error.code !== 'ERR_ABORTED') {
        console.warn('Could not load site:', error.code ?? 'navigation failed');
      }
    });
  }

  /** Every view fills the area below the toolbar (hidden ones too, so they are right when shown). */
  layout(): void {
    const [width, height] = this.win.getContentSize();
    const bounds = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
    for (const view of this.views.values()) view.setBounds(bounds);
  }

  private configureSession(): void {
    const ses = session.fromPartition(SITE_PARTITION);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    // Older One Tap flows render their automatic chooser in a dedicated iframe.
    ses.webRequest.onBeforeRequest({ urls: ['https://accounts.google.com/gsi/iframe/select*'] }, (details, callback) => {
      callback({ cancel: details.resourceType === 'subFrame' && new URL(details.url).pathname === '/gsi/iframe/select' });
    });
  }

  private createView(site: SiteDef): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: SITE_PARTITION,
        preload: this.preloadPath,
        additionalArguments: [SITE_CONFIG_ARG + JSON.stringify(site)],
        // Website content is untrusted: no Node, isolated world, OS-level sandbox.
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    // Keep the override local to Perplexity so ChatGPT uses Electron's native user agent.
    if (site.id === 'perplexity') wc.setUserAgent(chromeUserAgent());

    // Links that open a new window: stay in this view if the destination is allowed, else hand to the OS browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (isNavigationAllowed(site, url)) this.load(view, url);
      else this.openExternal(url);
      return { action: 'deny' };
    });

    // Top-level navigations (links, redirects, location changes) may not leave the allowlist.
    const guard = (event: { url: string; preventDefault(): void }) => {
      if (!isNavigationAllowed(site, event.url)) {
        event.preventDefault();
        this.openExternal(event.url);
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', (event) => { if (event.isMainFrame) guard(event); });

    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && this.current() === view) this.scanEpoch += 1;
    });
    wc.on('preload-error', (_event, _preload, error) => {
      if (this.views.get(site.id) !== view) return;
      console.error(`Could not install DLP protection for ${site.name}:`, error);
      this.views.delete(site.id);
      this.scanEpoch += 1;
      view.setVisible(false);
      this.win.contentView.removeChildView(view);
      wc.close();
      if (this.active === site.id) this.emitState();
    });

    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      wc.on(ev as 'did-navigate', () => {
        if (this.views.get(this.active) === view) this.emitState();
      });
    }
    return view;
  }
}
