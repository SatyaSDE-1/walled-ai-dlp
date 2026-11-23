// End-to-end test of the Electron shell. The Playwright driver starts the installed Electron
// app (real Chromium, real WebContentsViews, real
// Python child process) and points the two tabs at local mock pages, because the sandbox cannot reach
// chatgpt.com / perplexity.ai. Run under a display:  xvfb-run -a node test/e2e.mjs
//
// What this proves:   embedded views, navigation UI, layout, isolation/security settings, navigation
//                     allowlist, Python child lifecycle (start, ping, crash -> restart, clean shutdown).
// The fixture also exercises the real preload, inspection IPC and file replay on mock pages.
// Live website compatibility and native dialog interaction are separate checks.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const injectDir = path.join(desktop, '../server/dlp/inject');
const config = JSON.parse(await readFile(path.join(injectDir, 'config.json'), 'utf8'));
const { color: responseColor } = config;

// --- mock sites -----------------------------------------------------------------------------------
function page(title) {
  const perplexity = title.startsWith('MockPerplexity');
  if (title.endsWith('/auth/login')) {
    const googleControl = perplexity
      ? `<button id="google" onclick="location.href='https://accounts.google.com/o/oauth2/v2/auth'">Continue with Google</button>`
      : '<a id="google" href="/auth/login_with?connection=google-oauth2">Mit Google fortfahren</a>';
    return `<!doctype html><title>${title}</title><body>
      <form action="/auth/email" method="post">
        <label>Email <input type="email" name="email" required></label>
        <button id="email" type="submit">Continue</button>
      </form>
      ${googleControl}
      ${perplexity ? '' : '<form action="/auth/phone" method="post"><button id="phone">Use phone approval</button></form>'}
    </body>`;
  }
  return `<!doctype html><title>${title}</title><body><h1>${title}</h1>
    <a id="l" href="/second">next</a>
    <a id="external" href="https://example.com/reference" target="_blank">reference</a>
    <a id="login" href="/auth/login"${perplexity ? ' target="_blank"' : ''}>${perplexity ? 'Sign In' : 'Log in'}</a>
    <form id="composer">
      <textarea id="${perplexity ? 'ask-input' : 'prompt-textarea'}"></textarea>
      <button id="send" data-testid="${perplexity ? 'submit-button' : 'send-button'}">Send</button>
    </form>
    <input id="attachment" type="file" multiple>
    <div id="messages"></div>
    <script>
      window.__boot = Math.random();
      window.sent = [];
      window.picked = [];
      const form = document.getElementById('composer');
      const prompt = form.querySelector('textarea');
      const send = document.getElementById('send');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        window.sent.push(prompt.value);
      });
      prompt.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        form.requestSubmit(send);
      });
      document.getElementById('attachment').addEventListener('change', (event) => {
        window.picked.push(Array.from(event.target.files, (file) => file.name));
      });
    </script></body>`;
}
function mockServer(title) {
  return new Promise((resolve, reject) => {
    const phoneRequests = [];
    let phoneApproved = false;
    const srv = http.createServer((req, res) => {
      if (req.url === '/automatic-auth') {
        res.writeHead(302, { location: '/auth/login' }).end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (title === 'MockChatGPT' && req.url === '/cached-bootstrap') {
        const bypassesCache = req.headers['cache-control']?.includes('no-cache');
        const hasSession = req.headers.cookie?.includes('fixture-session=active');
        if (bypassesCache && hasSession) {
          res.setHeader('cache-control', 'no-store');
          res.end(page(`${title} recovered`));
        } else {
          res.setHeader('cache-control', 'max-age=600');
          res.setHeader('set-cookie', 'fixture-session=active; HttpOnly; SameSite=Lax; Path=/cached-bootstrap');
          res.end('<!doctype html><title>Blank cached page</title><body></body>');
        }
        return;
      }
      if (title === 'MockChatGPT' && req.url === '/auth/phone') {
        phoneRequests.push(req.method);
        if (req.method === 'POST') {
          req.resume();
          res.end('<!doctype html><title>Phone approval</title><main><h1>Check your phone</h1></main>');
        } else if (phoneApproved) {
          res.writeHead(303, { location: '/signed-in' }).end();
        } else {
          res.writeHead(403).end('Phone approval is still required.');
        }
        return;
      }
      if (title === 'MockChatGPT' && req.method === 'POST' && req.url === '/auth/email-google') {
        req.resume();
        res.end(`<!doctype html><body><script>location.replace('/auth/redirect-google')</script></body>`);
        return;
      }
      if (title === 'MockChatGPT' && req.url === '/auth/redirect-google') {
        res.writeHead(302, { location: '/auth/login_with?connection=google-oauth2' }).end();
        return;
      }
      if (req.method === 'POST' && req.url === '/auth/email') {
        req.resume();
        res.end('<!doctype html><title>Verify your email</title><input id="email-step" autocomplete="one-time-code">');
        return;
      }
      res.end(page(`${title} ${req.url}`));
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, phoneRequests, approvePhone: () => { phoneApproved = true; }, url: `http://127.0.0.1:${srv.address().port}/`,
    }));
  });
}

// --- tiny test runner -----------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL  ${name}\n        ${String(err.message ?? err).split('\n').join('\n        ')}`);
  }
}
async function until(fn, timeout = 15000, what = 'condition') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

// --- launch ---------------------------------------------------------------------------------------
const chatgpt = await mockServer('MockChatGPT');
const perplexity = await mockServer('MockPerplexity');
const profile = await mkdtemp(path.join(tmpdir(), 'walled-e2e-'));
const launchEnv = { ...process.env };
delete launchEnv.ELECTRON_RUN_AS_NODE;
delete launchEnv.ELECTRON_NO_ATTACH_CONSOLE;

const app = await electron.launch({
  timeout: 20_000,
  args: ['--disable-gpu', `--user-data-dir=${profile}`, desktop],
  cwd: desktop,
  env: {
    ...launchEnv,
    WALLED_E2E: '1',
    WALLED_E2E_SITES: JSON.stringify({ chatgpt: chatgpt.url, perplexity: perplexity.url }),
    WALLED_BACKEND_ARGS: '--no-ocr-warmup --auto-answer cancel',
  },
}).catch(async (error) => {
  chatgpt.srv.close();
  perplexity.srv.close();
  await rm(profile, { recursive: true, force: true });
  throw error;
});
const T = (fn, arg) => app.evaluate(fn, arg);            // run in the Electron main process
const readSite = (id, source) => T((_e, { id, source }) =>
  globalThis.__walledTest.views.all.get(id).webContents.executeJavaScript(source), { id, source });

async function submitInView(id, text, byClick = false) {
  await T(async (_e, { id, text, byClick }) => {
    const { views, win } = globalThis.__walledTest;
    const wc = views.all.get(id).webContents;
    win.focus();
    wc.focus();
    const point = await wc.executeJavaScript(`(() => {
      const prompt = document.querySelector('textarea');
      prompt.value = ${JSON.stringify(text)};
      prompt.focus();
      const rect = document.getElementById('send').getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    if (byClick) {
      const click = { ...point, button: 'left', clickCount: 1 };
      wc.sendInputEvent({ type: 'mouseDown', ...click });
      wc.sendInputEvent({ type: 'mouseUp', ...click });
    } else {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
  }, { id, text, byClick });
}

async function clickInView(id, selector) {
  await T(async (_e, { id, selector }) => {
    const { views, win } = globalThis.__walledTest;
    const wc = views.all.get(id).webContents;
    const point = await wc.executeJavaScript(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    })()`);
    win.focus();
    wc.focus();
    const click = { ...point, button: 'left', clickCount: 1 };
    wc.sendInputEvent({ type: 'mouseDown', ...click });
    wc.sendInputEvent({ type: 'mouseUp', ...click });
  }, { id, selector });
}

const shellPage = await until(async () =>
  app.windows().find((w) => w.url().includes('dist-renderer')), 20000, 'toolbar window');

try {
  console.log('\nPhase A - shell and embedded browser');

  await step('toolbar (React) renders both tabs', async () => {
    await shellPage.waitForSelector('[role=tab]');
    const names = await shellPage.locator('[role=tab]').allInnerTexts();
    assert.deepEqual(names, ['ChatGPT', 'Perplexity']);
  });

  await step('ChatGPT loads in an embedded WebContentsView and is the active tab', async () => {
    await until(() => T(() => globalThis.__walledTest.views.all.get('chatgpt')?.webContents.getURL()).then((u) => u.startsWith('http://127.0.0.1')), 15000, 'chatgpt url');
    const info = await T(() => {
      const v = globalThis.__walledTest.views.all.get('chatgpt');
      return { url: v.webContents.getURL(), title: v.webContents.getTitle(), visible: v.getVisible(), type: v.constructor.name };
    });
    assert.equal(info.type, 'WebContentsView');
    assert.ok(info.title.startsWith('MockChatGPT'), info.title);
    assert.equal(info.visible, true);
    assert.equal(await shellPage.locator('[role=tab][aria-selected=true]').innerText(), 'ChatGPT');
  });

  await step('view is laid out directly below the toolbar and fills the window', async () => {
    const r = await T(() => {
      const { win, views, toolbarHeight } = globalThis.__walledTest;
      const [w, h] = win.getContentSize();
      return { b: views.all.get('chatgpt').getBounds(), w, h, toolbarHeight };
    });
    assert.deepEqual(r.b, { x: 0, y: 56, width: r.w, height: r.h - 56 });
    // and the React toolbar really is that tall
    const toolbarPx = await shellPage.locator('header.toolbar').evaluate((el) => el.getBoundingClientRect().height);
    assert.equal(toolbarPx, r.toolbarHeight);
  });

  await step('clicking Perplexity loads its view, shows it, and hides ChatGPT', async () => {
    await shellPage.getByRole('tab', { name: 'Perplexity' }).click();
    await until(() => T(() => globalThis.__walledTest.views.all.get('perplexity')?.webContents.getTitle()).then((t) => t?.startsWith('MockPerplexity')), 15000, 'perplexity loaded');
    const vis = await T(() => {
      const a = globalThis.__walledTest.views.all;
      return { chatgpt: a.get('chatgpt').getVisible(), perplexity: a.get('perplexity').getVisible() };
    });
    assert.deepEqual(vis, { chatgpt: false, perplexity: true });
    const profiles = await T(() => [...globalThis.__walledTest.views.all.values()].map((v) => v.webContents.session.storagePath));
    assert.ok(profiles.every(Boolean));
    assert.equal(new Set(profiles).size, 2);
    await until(async () => (await shellPage.locator('[role=tab][aria-selected=true]').innerText()) === 'Perplexity');
  });

  await step('switching tabs keeps each page alive (no reload, state preserved)', async () => {
    const boot = () => T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript('window.__boot'));
    const before = await boot();
    await shellPage.getByRole('tab', { name: 'ChatGPT' }).click();
    await shellPage.getByRole('tab', { name: 'Perplexity' }).click();
    await shellPage.getByRole('tab', { name: 'ChatGPT' }).click();
    assert.equal(await boot(), before);
  });

  await step('ChatGPT keeps the native user agent even after Perplexity loads', async () => {
    assert.equal(await readSite('chatgpt', 'navigator.userAgent'),
      await shellPage.evaluate(() => navigator.userAgent));
  });

  await step('resizing the window re-lays out both views', async () => {
    await T(() => globalThis.__walledTest.win.setContentSize(900, 640));
    await until(() => T(() => {
      const a = globalThis.__walledTest.views.all;
      const ok = (v) => { const b = v.getBounds(); return b.width === 900 && b.height === 640 - 56 && b.y === 56; };
      return ok(a.get('chatgpt')) && ok(a.get('perplexity'));
    }), 10000, 'bounds update');
  });

  await step('back / forward / reload buttons drive the active view', async () => {
    await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript("document.getElementById('l').click()", true));   // real user gesture => real history entry
    await until(() => T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.getURL()).then((u) => u.endsWith('/second')), 10000, '/second');
    await until(async () => await shellPage.getByRole('button', { name: 'Back' }).isEnabled());
    await shellPage.getByRole('button', { name: 'Back' }).click();
    await until(() => T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.getURL()).then((u) => u.endsWith('/')), 10000, 'back to /');
    await until(async () => await shellPage.getByRole('button', { name: 'Forward' }).isEnabled());
    await shellPage.getByRole('button', { name: 'Forward' }).click();
    await until(() => T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.getURL()).then((u) => u.endsWith('/second')), 10000, 'forward');
    const before = await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript('window.__boot'));
    await shellPage.getByRole('button', { name: 'Reload' }).click();
    await until(async () => (await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript('window.__boot'))) !== before, 10000, 'reload');
  });

  await step('ChatGPT reload bypasses a blank cached page while preserving its session', async () => {
    const load = (url) => T((_e, url) => globalThis.__walledTest.views.all.get('chatgpt').webContents.loadURL(url), url);
    await load(new URL('cached-bootstrap', chatgpt.url).href);
    try {
      assert.equal(await readSite('chatgpt', 'document.body.innerText'), '');
      await shellPage.getByRole('button', { name: 'Reload' }).click();
      await until(() => readSite('chatgpt', 'document.title === "MockChatGPT recovered"'), 5000, 'ChatGPT cache bypass');
    } finally {
      await load(chatgpt.url);
    }
  });

  console.log('\nSecurity');

  await step('site views: contextIsolation on, nodeIntegration off, sandbox on', async () => {
    const prefs = await T(() => [...globalThis.__walledTest.views.all.values()].map((v) => {
      const p = v.webContents.getLastWebPreferences();
      return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, webviewTag: p.webviewTag, webSecurity: p.webSecurity };
    }));
    assert.equal(prefs.length, 2);
    for (const p of prefs) assert.deepEqual(p, { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, webSecurity: true });
  });

  await step('toolbar window: contextIsolation on, nodeIntegration off, sandbox on', async () => {
    const p = await T(() => { const q = globalThis.__walledTest.win.webContents.getLastWebPreferences(); return { c: q.contextIsolation, n: q.nodeIntegration, s: q.sandbox }; });
    assert.deepEqual(p, { c: true, n: false, s: true });
  });

  await step('website content sees no Node / Electron globals and no shell API', async () => {
    for (const id of ['chatgpt', 'perplexity']) {
      const seen = await T((_e, id) => globalThis.__walledTest.views.all.get(id).webContents.executeJavaScript(
        "[typeof require, typeof process, typeof module, typeof Buffer, typeof electron, typeof ipcRenderer, typeof __dirname, typeof walledShell, typeof __walledScan, typeof __walledInstalled].join(',')"), id);
      assert.equal(seen, Array(10).fill('undefined').join(','), `${id}: ${seen}`);
    }
  });

  await step('Google One Tap stays quiet until a user activates the page', async () => {
    const seen = await T(async () => {
      const wc = globalThis.__walledTest.views.all.get('chatgpt').webContents;
      // Chromium rejects the invalid mode before it contacts a provider.
      const attempt = `navigator.credentials.get({
        identity: {
          providers: [{ configURL: 'https://accounts.google.com/gsi/fedcm.json', clientId: 'test' }],
          mode: 'invalid',
        },
      }).catch(error => error.name)`;
      return {
        automatic: await wc.executeJavaScript(attempt),
        activated: await wc.executeJavaScript(attempt, true),
      };
    });
    assert.deepEqual(seen, { automatic: 'NotAllowedError', activated: 'TypeError' });
  });

  await step('the legacy Google One Tap iframe is blocked', async () => {
    const reason = await T(async () => {
      const wc = globalThis.__walledTest.views.all.get('perplexity').webContents;
      const url = 'https://accounts.google.com/gsi/iframe/select?client_id=test';
      let onFailure;
      let timeout;
      try {
        const failure = new Promise((resolve, reject) => {
          onFailure = (_event, _code, description, failedUrl) => {
            if (failedUrl === url) resolve(description);
          };
          wc.on('did-fail-load', onFailure);
          timeout = setTimeout(() => reject(new Error('The One Tap iframe did not fail to load')), 5000);
        });
        await wc.executeJavaScript(`void document.body.appendChild(Object.assign(document.createElement('iframe'), {
          src: ${JSON.stringify(url)}, hidden: true,
        }))`);
        return await failure;
      } finally {
        wc.off('did-fail-load', onFailure);
        clearTimeout(timeout);
      }
    });
    assert.equal(reason, 'ERR_BLOCKED_BY_CLIENT');
  });

  await step('toolbar exposes only the fixed API (no ipcRenderer / require)', async () => {
    const seen = await shellPage.evaluate(() => ({
      keys: Object.keys(window.walledShell).sort(),
      leaks: [typeof require, typeof process, typeof ipcRenderer].join(','),
    }));
    assert.deepEqual(seen.keys, ['getBackendStatus', 'getState', 'goBack', 'goForward', 'onBackendStatus', 'onState', 'reload', 'selectSite']);
    assert.equal(seen.leaks, 'undefined,undefined,undefined');
  });

  await step('toolbar IPC rejects calls from website content (site views cannot reach it)', async () => {
    // A site view has no bridge at all; confirm the invoke path is unreachable and the handler refuses foreign senders.
    const r = await T(async ({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers?.get('shell:select-site');
      if (!handler) return 'HANDLER-NOT-FOUND (cannot verify)';
      const fakeEvent = { sender: globalThis.__walledTest.views.all.get('chatgpt').webContents };
      try { await handler(fakeEvent, 'perplexity'); return 'ALLOWED'; } catch (e) { return String(e.message); }
    });
    assert.ok(r.includes('untrusted sender'), r);
  });

  await step('script-driven external navigation is blocked without opening the OS browser', async () => {
    const result = await T(async () => {
      const { views, externalOpened } = globalThis.__walledTest;
      externalOpened.length = 0;
      const wc = views.all.get('chatgpt').webContents;
      const before = wc.getURL();
      const canceled = new Promise((resolve) => wc.once('will-navigate', (event) => resolve(event.defaultPrevented)));
      await wc.executeJavaScript("location.href = 'https://example.com/redirect'; undefined");
      return { canceled: await canceled, before, url: wc.getURL(), opened: [...externalOpened] };
    });
    assert.equal(result.canceled, true);
    assert.equal(result.url, result.before);
    assert.deepEqual(result.opened, []);
  });

  await step('an external popup is denied and clicking an external link opens the OS browser', async () => {
    await T(() => { globalThis.__walledTest.externalOpened.length = 0; });
    await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript("window.open('https://example.com/popup'); undefined"));
    assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), []);
    await T(async () => {
      const { views, win } = globalThis.__walledTest;
      const wc = views.all.get('chatgpt').webContents;
      const point = await wc.executeJavaScript(`(() => {
        const rect = document.getElementById('external').getBoundingClientRect();
        return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
      })()`);
      win.focus();
      wc.focus();
      const click = { ...point, button: 'left', clickCount: 1 };
      wc.sendInputEvent({ type: 'mouseDown', ...click });
      wc.sendInputEvent({ type: 'mouseUp', ...click });
    });
    await until(() => T(() => globalThis.__walledTest.externalOpened.length > 0), 10000, 'external link handoff');
    assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), ['https://example.com/reference']);
    assert.equal(await T(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  });

  for (const [id, name, url] of [['chatgpt', 'ChatGPT', chatgpt.url], ['perplexity', 'Perplexity', perplexity.url]]) {
    await step(`${name} keeps Google handoff separate and allows normal sign-in`, async () => {
      await shellPage.getByRole('tab', { name }).click();
      await T(async (_e, { id, url }) => {
        const { views, externalOpened } = globalThis.__walledTest;
        externalOpened.length = 0;
        await views.all.get(id).webContents.loadURL(url);
      }, { id, url });
      const canceled = await T(async (_e, id) => {
        const { views } = globalThis.__walledTest;
        const wc = views.all.get(id).webContents;
        const submitted = new Promise((resolve) => wc.once('will-navigate', (event) => resolve(event.defaultPrevented)));
        await wc.executeJavaScript(`(() => {
          const form = document.createElement('form');
          form.action = '/auth/login';
          const field = document.createElement('input');
          field.type = 'email';
          form.appendChild(field);
          document.body.appendChild(form);
          form.requestSubmit();
        })()`);
        const formCanceled = await submitted;
        const redirect = new Promise((resolve) => wc.once('will-redirect', (event) => resolve(event.defaultPrevented)));
        await wc.executeJavaScript(`window.open('/auth/login'); location.href = '/automatic-auth'; void 0`);
        return formCanceled && await redirect;
      }, id);
      assert.equal(canceled, true);
      assert.equal(await readSite(id, 'location.pathname'), '/');
      assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), []);
      assert.equal(await T(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);

      await clickInView(id, '#login');
      await until(() => readSite(id, 'location.pathname === "/auth/login" && !!document.querySelector("input[type=email]")'), 5000, 'voluntary sign-in');
      assert.equal(await T(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      await T(({ dialog }) => {
        const hook = globalThis.__walledTest;
        hook.originalMessageBox = dialog.showMessageBox;
        hook.googleDialogs = [];
        dialog.showMessageBox = async (_window, options) => {
          hook.googleDialogs.push(options);
          return { response: 0, checkboxChecked: false };
        };
      });
      try {
        await readSite(id, 'document.querySelector("#google").click(); void 0');
        assert.deepEqual(await T(() => globalThis.__walledTest.googleDialogs), []);
        assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), []);

        await clickInView(id, '#google');
        await until(() => T(() => globalThis.__walledTest.externalOpened.length > 0), 5000, 'direct Google browser handoff');
        assert.deepEqual(await T(() => globalThis.__walledTest.googleDialogs), []);
        assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), [url]);
        assert.equal(await readSite(id, 'location.pathname === "/auth/login" && !!document.querySelector("input[type=email]")'), true);

        await readSite(id, `document.querySelector('input[type=email]').value = 'fixture@example.test'; void 0`);
        await clickInView(id, '#email');
        await until(() => readSite(id, 'location.pathname === "/auth/email" && !!document.querySelector("#email-step")'), 5000, 'website email flow');
        assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), [url]);
      } finally {
        await T(async ({ dialog }, { id, url }) => {
          const hook = globalThis.__walledTest;
          dialog.showMessageBox = hook.originalMessageBox;
          await hook.views.all.get(id).webContents.loadURL(url);
        }, { id, url });
      }
    });
  }

  await step('ChatGPT email routed to Google explains the block and restores the homepage', async () => {
    await shellPage.getByRole('tab', { name: 'ChatGPT' }).click();
    await T(({ dialog }) => {
      const hook = globalThis.__walledTest;
      hook.originalMessageBox = dialog.showMessageBox;
      hook.googleDialogs = [];
      hook.googleResponse = 0;
      hook.externalOpened.length = 0;
      hook.emailGoogleRedirectsBlocked = [];
      const wc = hook.views.all.get('chatgpt').webContents;
      wc.on('will-redirect', (event) => {
        if (new URL(event.url).pathname === '/auth/login_with') hook.emailGoogleRedirectsBlocked.push(event.defaultPrevented);
      });
      dialog.showMessageBox = async (_window, options) => {
        hook.googleDialogs.push(options);
        return { response: hook.googleResponse, checkboxChecked: false };
      };
    });
    try {
      for (const response of [0, 1]) {
        await T((_e, response) => { globalThis.__walledTest.googleResponse = response; }, response);
        await clickInView('chatgpt', '#login');
        await until(() => readSite('chatgpt', 'location.pathname === "/auth/login"'), 5000, 'ChatGPT sign-in page');
        await readSite('chatgpt', `(() => {
          const field = document.querySelector('input[type=email]');
          field.value = 'fixture@example.test';
          field.form.action = '/auth/email-google';
        })()`);
        await clickInView('chatgpt', '#email');
        const notice = await until(() => T((_e, response) => globalThis.__walledTest.googleDialogs[response], response),
          5000, 'notice after email is routed to Google');
        assert.match(notice.detail, /ChatGPT routed this email sign-in to Google/);
        assert.deepEqual(notice.buttons, ['Back to ChatGPT', 'Open Website in Browser']);
        await until(() => readSite('chatgpt', 'location.pathname === "/" && !!document.querySelector("#login")'),
          5000, 'homepage restored after blocked redirect');
        assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), response === 1 ? [chatgpt.url] : []);
      }
      assert.deepEqual(await T(() => globalThis.__walledTest.emailGoogleRedirectsBlocked), [true, true]);
    } finally {
      await T(async ({ dialog }, url) => {
        const hook = globalThis.__walledTest;
        dialog.showMessageBox = hook.originalMessageBox;
        await hook.views.all.get('chatgpt').webContents.loadURL(url);
      }, chatgpt.url);
    }
  });

  await step('ChatGPT recovers a stalled phone approval with one GET after the site starts completing sign-in', async () => {
    await shellPage.getByRole('tab', { name: 'ChatGPT' }).click();
    await clickInView('chatgpt', '#login');
    await until(() => readSite('chatgpt', 'location.pathname === "/auth/login"'), 5000, 'ChatGPT sign-in page');
    await clickInView('chatgpt', '#phone');
    await until(() => readSite('chatgpt', 'document.querySelector("h1")?.textContent === "Check your phone"'), 5000, 'phone approval challenge');
    try {
      await new Promise((resolve) => setTimeout(resolve, 6500));
      assert.deepEqual(chatgpt.phoneRequests, ['POST']);
      chatgpt.approvePhone();
      await readSite('chatgpt', 'document.querySelector("h1").textContent = "Completing sign-in…"; void 0');
      await until(() => readSite('chatgpt', 'location.pathname === "/signed-in"'), 14000, 'ChatGPT return without manual refresh');
      assert.deepEqual(chatgpt.phoneRequests, ['POST', 'GET']);
    } finally {
      await T((_e, url) => globalThis.__walledTest.views.all.get('chatgpt').webContents.loadURL(url), chatgpt.url);
    }
  });

  console.log('\nPhase B - Python backend');

  await step('Python child started by Electron; handshake + ping succeeded', async () => {
    const s = await T(() => ({ ...globalThis.__walledTest.backend.status, pid: globalThis.__walledTest.backend.pid }));
    assert.equal(s.state, 'ready');
    assert.match(s.version, /^\d+\.\d+\.\d+/);
    assert.ok(s.pid > 0);
  });

  await step('toolbar shows the backend as ready, with its version', async () => {
    await until(async () => /Ready/.test(await shellPage.getByTestId('backend-status').innerText()));
    assert.match(await shellPage.getByTestId('backend-status').innerText(), /Python backend: Ready · v\d/);
  });

  await step('both site preloads block marked prompts and replay explicit approvals once', async () => {
    for (const [id, byClick] of [['chatgpt', false], ['perplexity', true]]) {
      await shellPage.getByRole('tab', { name: id === 'chatgpt' ? 'ChatGPT' : 'Perplexity' }).click();
      await submitInView(id, 'ordinary prompt', byClick);
      await until(() => readSite(id, 'window.sent.length === 1'), 5000, 'ordinary prompt');
      await T(() => {
        const hook = globalThis.__walledTest;
        hook.originalCall = hook.backend.call;
        hook.pendingDecisions = [];
        hook.backend.call = function (op, ...args) {
          if (op !== 'prompt') return hook.originalCall.call(this, op, ...args);
          return new Promise((resolve) => hook.pendingDecisions.push(resolve));
        };
      });
      try {
        await submitInView(id, 'WALLED_SENSITIVE sample', byClick);
        await until(() => T(() => globalThis.__walledTest.pendingDecisions.length === 1), 5000, 'prompt held');
        await submitInView(id, 'WALLED_SENSITIVE sample', byClick);
        assert.deepEqual(await readSite(id, 'window.sent'), ['ordinary prompt']);
        await T(() => globalThis.__walledTest.pendingDecisions.shift()({ allow: false }));

        await until(async () => {
          await submitInView(id, 'WALLED_SENSITIVE sample', byClick);
          return T(() => globalThis.__walledTest.pendingDecisions.length === 1);
        }, 5000, 'new inspection after cancellation');
        await T(() => globalThis.__walledTest.pendingDecisions.shift()({ allow: true }));
        await until(() => readSite(id, 'window.sent.length === 2'), 5000, 'approved replay');
        assert.deepEqual(await readSite(id, 'window.sent'), ['ordinary prompt', 'WALLED_SENSITIVE sample']);
      } finally {
        await T(() => {
          const hook = globalThis.__walledTest;
          hook.backend.call = hook.originalCall;
          hook.pendingDecisions.forEach((resolve) => resolve({ allow: false }));
        });
      }
    }
  });

  await step('picker selections and drops onto the picker retain only approved files', async () => {
    const clean = path.join(profile, 'clean.txt');
    const marked = path.join(profile, 'marked.txt');
    await writeFile(clean, 'ordinary file');
    await writeFile(marked, 'WALLED_SENSITIVE');
    for (const [id, name] of [['chatgpt', 'ChatGPT'], ['perplexity', 'Perplexity']]) {
      await shellPage.getByRole('tab', { name }).click();
      await T(async (_e, { id, files }) => {
        const wc = globalThis.__walledTest.views.all.get(id).webContents;
        wc.debugger.attach('1.3');
        try {
          const { root } = await wc.debugger.sendCommand('DOM.getDocument');
          const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#attachment' });
          await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
        } finally {
          wc.debugger.detach();
        }
      }, { id, files: [marked, clean] });
      await until(() => readSite(id, 'window.picked.length === 1'), 5000, 'approved guest files');
      assert.deepEqual(await readSite(id, 'window.picked'), [['clean.txt']]);
    }

    await T(async (_e, files) => {
      const wc = globalThis.__walledTest.views.all.get('perplexity').webContents;
      const point = await wc.executeJavaScript(`(() => {
        const rect = document.getElementById('attachment').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
      wc.debugger.attach('1.3');
      try {
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await wc.debugger.sendCommand('Input.dispatchDragEvent', {
            type, ...point, data: { items: [], files, dragOperationsMask: 1 },
          });
        }
      } finally {
        wc.debugger.detach();
      }
    }, [marked, clean]);
    await until(() => readSite('perplexity', 'window.picked.length === 2'), 5000, 'approved drop');
    assert.deepEqual(await readSite('perplexity', 'window.picked'), [['clean.txt'], ['clean.txt']]);
  });

  await step('file paste is held, scanned by Python, and replayed with only approved files', async () => {
    const guard = await readFile(path.join(injectDir, 'guard.js'), 'utf8');
    // Use real Chromium clipboard events without touching the user's system pasteboard.
    // Only this isolated fixture permits the synthetic file-bearing event to reach the scanner.
    const script = `${guard}
      window.pasted = [];
      window.pendingScans = [];
      installWalledGuard(${JSON.stringify({ ...config, requireTrustedFileEvents: false })},
        ${JSON.stringify({ ...config.sites.chatgpt, responseSelectors: [] })},
        (payload) => new Promise((resolve) => window.pendingScans.push({ payload, resolve })));
      document.querySelector('textarea').addEventListener('paste', ({ clipboardData }) => {
        window.pasted.push({ files: Array.from(clipboardData.files, ({ name }) => name), text: clipboardData.getData('text/plain') });
      });
      window.firePaste = (fillTransfer) => {
        const transfer = new DataTransfer();
        fillTransfer(transfer);
        const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true, composed: true });
        return document.querySelector('textarea').dispatchEvent(event);
      };
      void 0;`;
    const id = await T(async ({ BrowserWindow }, { url, script }) => {
      const fixture = new BrowserWindow({ show: false });
      try {
        await fixture.loadURL(url);
        await fixture.webContents.executeJavaScript(script);
        return fixture.id;
      } catch (error) {
        fixture.destroy();
        throw error;
      }
    }, { url: chatgpt.url, script });
    const readPaste = (source) => T(({ BrowserWindow }, { id, source }) =>
      BrowserWindow.fromId(id).webContents.executeJavaScript(source), { id, source });

    try {
      assert.equal(await readPaste(`firePaste((data) => data.setData('text/plain', 'ordinary text'))`), true);
      for (const [type, value] of [
        ['text/html', '<img src="&#100;ata:image/png;base64,aGVsbG8=">'],
        ['text/uri-list', 'file:///tmp/attachment.pdf'],
        ['application/pdf', 'opaque clipboard attachment'],
      ]) {
        assert.equal(await readPaste(`firePaste((data) => data.setData(${JSON.stringify(type)}, ${JSON.stringify(value)}))`), false);
      }
      assert.deepEqual(await readPaste('pasted'), [{ files: [], text: 'ordinary text' }]);
      assert.equal(await readPaste('pendingScans.length'), 0);

      assert.equal(await readPaste(`firePaste((data) => {
        data.items.add(new File(['WALLED_SENSITIVE'], 'marked.txt', { type: 'text/plain' }));
        data.items.add(new File(['ordinary file'], 'clean.txt', { type: 'text/plain' }));
        data.setData('text/html', '<img src="data:image/png;base64,aGVsbG8=">');
      })`), false);
      for (const [name, body, allow] of [['marked.txt', 'WALLED_SENSITIVE', false], ['clean.txt', 'ordinary file', true]]) {
        const payload = await until(() => readPaste('pendingScans[0]?.payload'), 5000, name);
        assert.deepEqual(payload, { kind: 'file', site: 'ChatGPT', name, mimeType: 'text/plain', size: body.length,
          b64: Buffer.from(body).toString('base64') });
        assert.equal(await readPaste('pasted.length'), 1);
        const decision = await T((_e, file) => globalThis.__walledTest.backend.call('file', file), payload);
        assert.equal(decision.allow, allow);
        await readPaste(`pendingScans.shift().resolve(${JSON.stringify(decision)})`);
      }
      await until(() => readPaste('pasted.length === 2'), 5000, 'one approved paste replay');
      assert.deepEqual(await readPaste('pasted[1]'), { files: ['clean.txt'], text: '' });
      assert.equal(await readPaste('pendingScans.length'), 0);
    } finally {
      await T(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id);
    }
  });

  await step('the production preload blocks a page-scripted file paste', async () => {
    const result = await readSite('perplexity', `(() => {
      const data = new DataTransfer();
      data.items.add(new File(['WALLED_SENSITIVE'], 'marked.txt'));
      const target = document.querySelector('textarea');
      let reachedPage = false;
      function listen() { reachedPage = true; }
      target.addEventListener('paste', listen);
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      target.removeEventListener('paste', listen);
      return { canceled: event.defaultPrevented, reachedPage };
    })()`);
    assert.deepEqual(result, { canceled: true, reachedPage: false });
  });

  await step('an approval is discarded after switching away and back', async () => {
    const decision = await T(async ({ ipcMain }) => {
      const { backend, views } = globalThis.__walledTest;
      const handler = ipcMain._invokeHandlers.get('site:scan');
      const sender = views.all.get('perplexity').webContents;
      const originalCall = backend.call;
      let approve;
      backend.call = () => new Promise((resolve) => { approve = resolve; });
      try {
        const result = handler({ sender, senderFrame: sender.mainFrame }, { kind: 'prompt', text: 'WALLED_SENSITIVE' });
        views.select('chatgpt');
        views.select('perplexity');
        approve({ allow: true });
        return await result;
      } finally {
        backend.call = originalCall;
      }
    });
    assert.deepEqual(decision, { allow: false });
  });

  await step('streamed assistant content is coloured on both sites', async () => {
    for (const id of ['chatgpt', 'perplexity']) {
      const response = id === 'chatgpt' ? '<div data-message-author-role="assistant"><p id="answer">Answer</p></div>'
        : '<div data-workflow-final-text><div class="prose" data-renderer="lm"><p id="answer">Answer</p></div></div>';
      const colors = await readSite(id, `(() => {
        document.getElementById('messages').innerHTML = ${JSON.stringify(response + '<div data-message-bubble="right" data-message-author-role="user" id="question">Question</div>')};
        const expected = document.createElement('span');
        expected.style.color = ${JSON.stringify(responseColor)};
        document.body.append(expected);
        return ['answer', 'question'].map(id => getComputedStyle(document.getElementById(id)).color)
          .concat(getComputedStyle(expected).color);
      })()`);
      assert.equal(colors[0], colors[2]);
      assert.notEqual(colors[1], colors[0]);
    }
  });

  await step('round trip to the existing Guard: clean prompt allowed; marker prompt hits (auto) dialog -> Cancel', async () => {
    const r = await T(async () => {
      const b = globalThis.__walledTest.backend;
      return {
        clean: await b.call('prompt', { site: 'ChatGPT', text: 'hello' }),
        marked: await b.call('prompt', { site: 'ChatGPT', text: 'secret WALLED_SENSITIVE' }, 0),
      };
    });
    assert.deepEqual(r.clean, { allow: true });
    assert.deepEqual(r.marked, { allow: false });      // backend was started with --auto-answer cancel
  });

  await step('init_script packages the shared page guard', async () => {
    const s = await T(async () => (await globalThis.__walledTest.backend.call('init_script')).script);
    assert.ok(s.includes('WALLED_SENSITIVE') && s.includes('__WALLED_CONFIG__') && s.includes('chatgpt.com'));
  });

  await step('a malformed request is rejected by Python, backend stays healthy', async () => {
    const r = await T(async () => {
      const b = globalThis.__walledTest.backend;
      let err = '';
      try { await b.call('prompt', { site: 'x', text: 5 }); } catch (e) { err = e.message; }
      return { err, ping: (await b.call('ping')).pong };
    });
    assert.match(r.err, /bad_request/);
    assert.equal(r.ping, true);
  });

  let oldPid;
  await step('crash recovery: killing Python -> status restarting -> new pid -> calls work again', async () => {
    oldPid = await T(() => globalThis.__walledTest.backend.pid);
    await T(() => { process.kill(globalThis.__walledTest.backend.pid, 'SIGKILL'); });
    await until(() => T(() => globalThis.__walledTest.backend.status.state !== 'ready'), 10000, 'leaving ready');
    await until(() => T(() => globalThis.__walledTest.backend.status.state === 'ready'), 20000, 'ready again');
    const s = await T(() => ({ pid: globalThis.__walledTest.backend.pid, restarts: globalThis.__walledTest.backend.status.restarts, pong: null }));
    assert.notEqual(s.pid, oldPid);
    assert.equal(s.restarts, 1);
    assert.equal((await T(() => globalThis.__walledTest.backend.call('ping'))).pong, true);
  });

  await step('a call in flight when Python dies is rejected, not lost', async () => {
    const msg = await T(async () => {
      const b = globalThis.__walledTest.backend;
      // the dialog op blocks (auto-answer is instant, so use a slow op: huge prompt scan is not slow either) -> kill right after sending
      const p = b.call('ping');
      process.kill(b.pid, 'SIGKILL');
      try { await p; return 'resolved'; } catch (e) { return e.message; }
    });
    // Either the ping answered before the kill landed, or it was rejected with a clear reason. Never a hang.
    assert.ok(msg === 'resolved' || /exited|not ready|connection failed/.test(msg), msg);
    await until(() => T(() => globalThis.__walledTest.backend.status.state === 'ready'), 20000, 'ready again');
  });

  if (process.platform !== 'win32') {
    await step('a backend timeout rejects the decision and recovers without disabling site switching', async () => {
      const result = await T(async () => {
        const { backend } = globalThis.__walledTest;
        const pid = backend.pid;
        process.kill(pid, 'SIGSTOP');
        try {
          await backend.call('prompt', { site: 'Perplexity', text: 'WALLED_SENSITIVE' }, 100);
          return { pid, error: '' };
        } catch (error) {
          return { pid, error: error.message };
        } finally {
          process.kill(pid, 'SIGCONT');
        }
      });
      assert.match(result.error, /timed out/);
      await shellPage.getByRole('tab', { name: 'ChatGPT' }).click();
      await until(async () => (await shellPage.getByRole('tab', { name: 'ChatGPT' }).getAttribute('aria-selected')) === 'true');
      await until(() => T((_e, old) => {
        const { backend } = globalThis.__walledTest;
        return backend.status.state === 'ready' && backend.pid !== old;
      }, result.pid), 20000, 'recovery after timeout');
    });
  }

  var lastPid = await T(() => globalThis.__walledTest.backend.pid);
} finally {
  await app.close().catch(() => {});
  chatgpt.srv.close();
  perplexity.srv.close();
  await rm(profile, { recursive: true, force: true });
}

await step('quitting the app leaves no orphaned Python process', async () => {
  await until(() => {
    try { process.kill(lastPid, 0); return false; } catch { return true; }   // throws once the pid is gone
  }, 10000, 'python exit');
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
