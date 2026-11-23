import { EventEmitter } from 'node:events';
import { WebContentsView, session, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type LoadURLOptions } from 'electron';
import { TOOLBAR_HEIGHT, type ShellState, type SiteId } from '../shared/types';
import { authenticationTarget, externalLinkUrl, isChatGptSignInDocument, isDlpDocument, isNavigationAllowed, SITE_CONFIG_ARG, type SiteDef } from './sites';

const SITE_PARTITIONS: Record<SiteId, string> = {
  chatgpt: 'persist:walled-sites', // Keep the existing profile for the default tab.
  perplexity: 'persist:walled-perplexity',
};
const SIGN_IN_WINDOW_MS = 30_000;
/** How many times the app may refresh a ChatGPT "Completing sign-in" screen that does not finish by itself. */
const MAX_CHATGPT_RECOVERIES = 3;
const CHATGPT_UNCACHED_LOAD: LoadURLOptions = { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache' };
/** Opt-in sign-in diagnosis. Log origins without paths or query strings. */
const DEBUG_NAV = process.env.WALLED_DEBUG_NAV === '1';
const navigationOrigin = (raw: string): string => {
  try {
    return new URL(raw).origin;
  } catch {
    return '(invalid url)';
  }
};

interface SiteTab {
  site: SiteDef;
  view: WebContentsView;
  started: boolean;
  loadFailed: boolean;
  preloadFailed: boolean;
  signInUntil: number;
  emailSignIn: boolean;
  chatGptRecoveries: number;
}

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

/** Owns the two persistent browser views and reports the selected view's state. */
export class SiteViews extends EventEmitter {
  private readonly tabs = new Map<SiteId, SiteTab>();
  private active: SiteId = 'chatgpt';
  private scanEpoch = 0;

  constructor(
    private readonly win: BrowserWindow,
    private readonly sites: Record<SiteId, SiteDef>,
    private readonly preloadPath: string,
    private readonly openExternal: (url: URL, emailRoutedSite?: string) => void,
  ) {
    super();
    for (const site of Object.values(sites)) {
      const tab = this.createTab(site);
      this.tabs.set(site.id, tab);
      tab.view.setVisible(false);
      win.contentView.addChildView(tab.view);
    }
    for (const event of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      win.on(event as 'resize', () => this.layout());
    }
    this.layout();
  }

  select(id: SiteId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.active !== id) {
      this.scanEpoch += 1;
      const previous = this.current();
      if (previous) previous.signInUntil = 0;
    }
    this.active = id;
    for (const entry of this.tabs.values()) entry.view.setVisible(entry === tab && !entry.preloadFailed);
    if (!tab.started) this.load(tab, tab.site.url);
    this.emitState();
  }

  get inspectionEpoch(): number {
    return this.scanEpoch;
  }

  goBack(): void {
    this.navigateHistory(-1);
  }

  goForward(): void {
    this.navigateHistory(1);
  }

  reload(): void {
    const tab = this.current();
    if (!tab) return;
    if (tab.preloadFailed) {
      const replacement = this.createTab(tab.site);
      this.tabs.set(tab.site.id, replacement);
      this.win.contentView.addChildView(replacement.view);
      this.layout();
      this.select(tab.site.id);
      return;
    }
    const wc = tab.view.webContents;
    const url = wc.getURL();
    if (!isNavigationAllowed(tab.site, url) || url === 'about:blank') {
      this.load(tab, tab.site.url, tab.site.id === 'chatgpt' ? CHATGPT_UNCACHED_LOAD : undefined);
    } else if (tab.site.id === 'chatgpt') {
      wc.reloadIgnoringCache();
    } else {
      wc.reload();
    }
  }

  openExternalLink(event: IpcMainEvent, rawUrl: unknown): void {
    const tab = this.current();
    const frame = event.senderFrame;
    if (!tab || tab.preloadFailed || !frame || event.sender !== tab.view.webContents || frame !== event.sender.mainFrame) return;
    if (!isNavigationAllowed(tab.site, frame.url) || typeof rawUrl !== 'string') return;
    const url = externalLinkUrl(rawUrl);
    if (url && !isNavigationAllowed(tab.site, url.href)) this.openExternal(url);
  }

  requestSignIn(event: IpcMainEvent, action: unknown): void {
    const tab = this.current();
    const frame = event.senderFrame;
    if (!tab || tab.preloadFailed || !frame || event.sender !== tab.view.webContents || frame !== event.sender.mainFrame
      || frame.url === 'about:blank' || !isNavigationAllowed(tab.site, frame.url)) return;
    if (action === 'sign-in' || (action === 'email-sign-in' && tab.site.id === 'chatgpt')) {
      tab.signInUntil = Date.now() + SIGN_IN_WINDOW_MS;
      tab.emailSignIn = action === 'email-sign-in';
    } else if (action === 'google') {
      this.openExternal(new URL(tab.site.url));
    } else if (action === 'retry-chatgpt-completion' && tab.chatGptRecoveries < MAX_CHATGPT_RECOVERIES
      && isChatGptSignInDocument(tab.site, frame.url)) {
      tab.chatGptRecoveries += 1;
      this.recoverChatGptSignIn(tab, frame.url);
    }
  }

  private recoverChatGptSignIn(tab: SiteTab, signInUrl: string): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const pending = wc.isLoadingMainFrame();
    if (DEBUG_NAV) {
      console.log(`[nav] recovery ${tab.chatGptRecoveries}/${MAX_CHATGPT_RECOVERIES}: refreshing ${navigationOrigin(signInUrl)}`
        + ` (mainFrameLoading=${pending})`);
    }
    if (pending) wc.stop();
    // Retry the validated document with a GET so a previous sign-in form is not resubmitted.
    this.load(tab, signInUrl, CHATGPT_UNCACHED_LOAD);
  }

  scanSite(event: IpcMainInvokeEvent): SiteDef | undefined {
    const tab = this.current();
    const frame = event.senderFrame;
    if (tab && !tab.preloadFailed && frame && event.sender === tab.view.webContents && frame === event.sender.mainFrame
      && isDlpDocument(tab.site, frame.url)) {
      return tab.site;
    }
    return undefined;
  }

  getState(): ShellState {
    const tab = this.current();
    const wc = tab && !tab.preloadFailed ? tab.view.webContents : undefined;
    const startUrl = this.sites[this.active].url;
    const currentUrl = wc?.getURL();
    return {
      sites: Object.values(this.sites).map(({ id, name }) => ({ id, name })),
      active: this.active,
      host: new URL(currentUrl && isNavigationAllowed(this.sites[this.active], currentUrl) ? currentUrl : startUrl).host,
      loading: wc?.isLoadingMainFrame() ?? false,
      loadFailed: tab?.preloadFailed === true || tab?.loadFailed === true,
      canGoBack: this.canNavigateHistory(tab, -1),
      canGoForward: this.canNavigateHistory(tab, 1),
    };
  }

  /** Test diagnostics. */
  get all(): ReadonlyMap<SiteId, WebContentsView> {
    return new Map(Array.from(this.tabs, ([id, tab]) => [id, tab.view]));
  }

  dispose(): void {
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    for (const { view, preloadFailed } of tabs) {
      if (!preloadFailed && !this.win.isDestroyed()) this.win.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
  }

  private current(): SiteTab | undefined {
    return this.tabs.get(this.active);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }

  private canNavigateHistory(tab: SiteTab | undefined, offset: -1 | 1): boolean {
    if (!tab || tab.preloadFailed) return false;
    const history = tab.view.webContents.navigationHistory;
    if (!history.canGoToOffset(offset)) return false;
    const entry = history.getEntryAtIndex(history.getActiveIndex() + offset);
    return !!entry && isNavigationAllowed(tab.site, entry.url) && authenticationTarget(tab.site, entry.url) !== 'google';
  }

  private navigateHistory(offset: -1 | 1): void {
    const tab = this.current();
    if (tab && this.canNavigateHistory(tab, offset)) {
      tab.view.webContents.navigationHistory.goToOffset(offset);
    }
  }

  private layout(): void {
    const [width, height] = this.win.getContentSize();
    const bounds = { x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) };
    for (const tab of this.tabs.values()) {
      if (!tab.preloadFailed) tab.view.setBounds(bounds);
    }
  }

  private load(tab: SiteTab, url: string, options?: LoadURLOptions): void {
    const wc = tab.view.webContents;
    if (tab.preloadFailed || wc.isDestroyed() || !isNavigationAllowed(tab.site, url)) return;
    tab.started = true;
    void wc.loadURL(url, options).catch((error: NodeJS.ErrnoException) => {
      if (!wc.isDestroyed() && error.code !== 'ERR_ABORTED') {
        console.warn(`Could not load ${tab.site.name}:`, error.code ?? 'Navigation failed');
      }
    });
  }

  private createTab(site: SiteDef): SiteTab {
    const profile = session.fromPartition(SITE_PARTITIONS[site.id]);
    // Let ChatGPT's browser verification see Electron's native user agent.
    if (site.id === 'perplexity') profile.setUserAgent(chromeUserAgent());
    profile.setPermissionRequestHandler((_contents, permission, reply) => reply(permission === 'clipboard-sanitized-write'));
    profile.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write');
    // Older versions of One Tap open the automatic chooser in a dedicated iframe.
    profile.webRequest.onBeforeRequest({ urls: ['https://accounts.google.com/gsi/iframe/select*'] }, (details, reply) => {
      reply({ cancel: details.resourceType === 'subFrame' && new URL(details.url).pathname === '/gsi/iframe/select' });
    });

    const view = new WebContentsView({
      webPreferences: {
        session: profile,
        preload: this.preloadPath,
        additionalArguments: [SITE_CONFIG_ARG + JSON.stringify(site)],
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
    const tab: SiteTab = { site, view, started: false, loadFailed: false, preloadFailed: false,
      signInUntil: 0, emailSignIn: false, chatGptRecoveries: 0 };
    const wc = view.webContents;
    const trace = (message: string) => {
      if (DEBUG_NAV && site.id === 'chatgpt') console.log(`[nav] ${message}`);
    };

    const canNavigate = (url: string) => {
      if (!isNavigationAllowed(site, url)) return false;
      const auth = authenticationTarget(site, url);
      if (auth === 'google') return false;
      return auth === null || (this.current() === tab && (Date.now() < tab.signInUntil
        || authenticationTarget(site, wc.getURL()) === 'sign-in'));
    };
    const recoverGoogleEmailRedirect = (url: string) => {
      if (!tab.emailSignIn || this.current() !== tab || Date.now() >= tab.signInUntil
        || authenticationTarget(site, url) !== 'google') return;
      tab.emailSignIn = false;
      tab.signInUntil = 0;
      setImmediate(() => {
        if (this.current() !== tab || tab.preloadFailed || wc.isDestroyed()) return;
        if (isChatGptSignInDocument(site, wc.mainFrame.url)) this.load(tab, site.url, CHATGPT_UNCACHED_LOAD);
        this.openExternal(new URL(site.url), site.name);
      });
    };
    wc.setWindowOpenHandler(({ url, postBody, referrer }) => {
      if (!postBody && url !== 'about:blank' && canNavigate(url)) {
        setImmediate(() => {
          if (this.current() === tab && canNavigate(url)) this.load(tab, url, { httpReferrer: referrer });
        });
      }
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event) => {
      if (!canNavigate(event.url)) {
        trace(`BLOCKED will-navigate -> ${navigationOrigin(event.url)}`);
        event.preventDefault();
        recoverGoogleEmailRedirect(event.url);
      }
    });
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame && authenticationTarget(site, event.url) && !canNavigate(event.url)) {
        trace(`BLOCKED subframe -> ${navigationOrigin(event.url)}`);
        event.preventDefault();
      }
    });
    wc.on('will-redirect', (event) => {
      if ((event.isMainFrame || authenticationTarget(site, event.url)) && !canNavigate(event.url)) {
        trace(`BLOCKED redirect -> ${navigationOrigin(event.url)}`);
        event.preventDefault();
        if (event.isMainFrame) recoverGoogleEmailRedirect(event.url);
      }
    });

    const refresh = () => {
      if (this.current() === tab) this.emitState();
    };
    wc.on('preload-error', (_event, _preload, error) => {
      if (tab.preloadFailed || this.tabs.get(site.id) !== tab) return;
      console.error(`Could not install DLP protection for ${site.name}:`, error);
      tab.preloadFailed = true;
      view.setVisible(false);
      this.win.contentView.removeChildView(view);
      wc.close();
      refresh();
    });
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame) trace(`start ${navigationOrigin(event.url)}${event.isSameDocument ? ' (same-document)' : ''}`);
      if (event.isMainFrame && this.current() === tab) this.scanEpoch += 1;
      if (!tab.preloadFailed && event.isMainFrame && !event.isSameDocument) {
        tab.loadFailed = false;
        refresh();
      }
    });
    wc.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (isMainFrame) trace(`load failed code=${code} ${navigationOrigin(url)}`);
      if (isMainFrame && code !== -3) { // Chromium ERR_ABORTED covers canceled and replaced navigations.
        tab.loadFailed = true;
        refresh();
      }
    });
    wc.on('render-process-gone', () => {
      tab.loadFailed = true;
      refresh();
    });
    wc.on('did-start-loading', refresh);
    wc.on('did-stop-loading', refresh);
    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      trace(`committed ${navigationOrigin(url)} (HTTP ${httpResponseCode})`);
      if (!authenticationTarget(site, url)) {
        tab.signInUntil = 0;
        tab.emailSignIn = false;
        tab.chatGptRecoveries = 0;
      }
      refresh();
    });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) refresh();
    });
    return tab;
  }
}
