// End-to-end test of the Electron shell. Runs the REAL app (real Chromium, real WebContentsViews, real
// Python child process) and points the two tabs at local mock pages, because the sandbox cannot reach
// chatgpt.com / perplexity.ai. Run under a display:  xvfb-run -a node test/e2e.mjs
//
// Tests the shell, site preloads, and Python child against local ChatGPT and Perplexity fixtures.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const { color: responseColor } = JSON.parse(await readFile(
  new URL('../../server/dlp/inject/config.json', import.meta.url), 'utf8',
));

// --- mock sites -----------------------------------------------------------------------------------
const page = (title) => {
  const perplexity = title.startsWith('MockPerplexity');
  return `<!doctype html><title>${title}</title><body><h1>${title}</h1><a id="l" href="/second">next</a>
    <form>
      <textarea id="${perplexity ? 'ask-input' : 'prompt-textarea'}"></textarea>
      <button data-testid="${perplexity ? 'submit-button' : 'send-button'}">Send</button>
    </form>
    <input id="attachment" type="file" multiple>
    <script>
      window.__boot = Math.random();
      window.sent = [];
      window.picked = [];
      const form = document.querySelector('form');
      const prompt = form.querySelector('textarea');
      form.addEventListener('submit', event => {
        event.preventDefault();
        window.sent.push(prompt.value);
      });
      prompt.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          form.requestSubmit(form.querySelector('button'));
        }
      });
      document.getElementById('attachment').addEventListener('change', event => {
        window.picked.push(Array.from(event.target.files, file => file.name));
      });
    </script></body>`;
};
function mockServer(title) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(page(`${title} ${req.url}`));
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
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

const app = await electron.launch({
  args: ['--no-sandbox', '--disable-gpu', '--host-resolver-rules=MAP accounts.google.com ~NOTFOUND',
    `--user-data-dir=${profile}`, desktop],
  cwd: desktop,
  env: {
    ...process.env,
    WALLED_E2E: '1',
    WALLED_E2E_SITES: JSON.stringify({ chatgpt: chatgpt.url, perplexity: perplexity.url }),
    WALLED_BACKEND_ARGS: '--no-ocr-warmup --auto-answer cancel',
  },
});
const T = (fn, arg) => app.evaluate(fn, arg);            // run in the Electron main process
const readSite = (id, script) => T((_electron, { id, script }) =>
  globalThis.__walledTest.views.all.get(id).webContents.executeJavaScript(script), { id, script });

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

  await step('Google One Tap requires user activation for FedCM', async () => {
    await until(() => readSite('chatgpt', '!navigator.userActivation.isActive'), 7000, 'no transient activation');
    const seen = await T(async () => {
      const wc = globalThis.__walledTest.views.all.get('chatgpt').webContents;
      const attempt = `navigator.credentials.get({
        identity: {
          providers: [{ configURL: 'https://accounts.google.com/gsi/fedcm.json', clientId: 'test' }],
          mode: 'invalid',
        },
      }).catch(error => error.name)`;
      // The invalid mode makes Chromium reject a forwarded request before contacting Google.
      return {
        automatic: await wc.executeJavaScript(attempt),
        clicked: await wc.executeJavaScript(attempt, true),
      };
    });
    assert.deepEqual(seen, { automatic: 'NotAllowedError', clicked: 'TypeError' });
  });

  await step('the legacy One Tap iframe is blocked', async () => {
    const reason = await T(async () => {
      const wc = globalThis.__walledTest.views.all.get('chatgpt').webContents;
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

  await step('clicking Perplexity creates its view, shows it, hides ChatGPT', async () => {
    await shellPage.getByRole('tab', { name: 'Perplexity' }).click();
    await until(() => T(() => globalThis.__walledTest.views.all.get('perplexity')?.webContents.getTitle()).then((t) => t?.startsWith('MockPerplexity')), 15000, 'perplexity loaded');
    const vis = await T(() => {
      const a = globalThis.__walledTest.views.all;
      return { chatgpt: a.get('chatgpt').getVisible(), perplexity: a.get('perplexity').getVisible() };
    });
    assert.deepEqual(vis, { chatgpt: false, perplexity: true });
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
    const userAgent = await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents
      .executeJavaScript('navigator.userAgent'));
    assert.equal(userAgent, await shellPage.evaluate(() => navigator.userAgent));
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
        "[typeof require, typeof process, typeof module, typeof Buffer, typeof electron, typeof ipcRenderer, typeof __dirname, typeof walledShell].join(',')"), id);
      assert.equal(seen, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined', `${id}: ${seen}`);
    }
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

  await step('navigation to a non-allowlisted host is blocked and handed to the OS browser', async () => {
    await T(() => { globalThis.__walledTest.externalOpened.length = 0; });
    const before = await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.getURL());
    await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript("location.href = 'https://example.com/phish'"));
    await until(() => T(() => globalThis.__walledTest.externalOpened.length > 0), 10000, 'external open');
    assert.equal(await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.getURL()), before);
    assert.deepEqual(await T(() => globalThis.__walledTest.externalOpened), ['https://example.com/phish']);
  });

  await step('window.open to a foreign host is denied (no new window) and handed to the OS', async () => {
    await T(() => { globalThis.__walledTest.externalOpened.length = 0; });
    await T(() => globalThis.__walledTest.views.all.get('chatgpt').webContents.executeJavaScript("window.open('https://evil.example/x'); 1"));
    await until(() => T(() => globalThis.__walledTest.externalOpened.length > 0), 10000, 'external open');
    assert.equal(await T(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
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

  await step('both site preloads hold marked prompts and send clean prompts', async () => {
    for (const [id, name] of [['chatgpt', 'ChatGPT'], ['perplexity', 'Perplexity']]) {
      await shellPage.getByRole('tab', { name }).click();
      const submit = (text) => T(async (_electron, { id, text }) => {
        const wc = globalThis.__walledTest.views.all.get(id).webContents;
        await wc.executeJavaScript(`Object.assign(document.querySelector('textarea'), { value: ${JSON.stringify(text)} }).focus()`);
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }, { id, text });
      await submit('ordinary prompt');
      await until(() => readSite(id, 'window.sent.length === 1'), 5000, 'clean prompt submitted');

      await T(() => {
        const hook = globalThis.__walledTest;
        hook.originalCall = hook.backend.call;
        hook.pendingPrompt = undefined;
        hook.backend.call = async function (op, payload, ...args) {
          const decision = await hook.originalCall.call(this, op, payload, ...args);
          if (op === 'prompt') {
            hook.lastPrompt = { payload, decision };
            // Hold the decision to observe that the page has not received the prompt.
            await new Promise((resolve) => { hook.pendingPrompt = resolve; });
          }
          return decision;
        };
      });
      try {
        await submit('marked WALLED_SENSITIVE prompt');
        await until(() => T(() => !!globalThis.__walledTest.pendingPrompt), 5000, 'marked prompt inspected');
        assert.deepEqual(await T(() => globalThis.__walledTest.lastPrompt), {
          payload: { site: name, text: 'marked WALLED_SENSITIVE prompt' }, decision: { allow: false },
        });
        assert.deepEqual(await readSite(id, 'window.sent'), ['ordinary prompt']);
      } finally {
        await T(() => {
          const hook = globalThis.__walledTest;
          hook.pendingPrompt?.();
          hook.backend.call = hook.originalCall;
        });
      }
      assert.equal(await readSite(id, 'document.querySelector("textarea").value'), 'marked WALLED_SENSITIVE prompt');
    }
  });

  await step('file picker replays only files approved by Python', async () => {
    const clean = path.join(profile, 'clean.txt');
    const marked = path.join(profile, 'marked.txt');
    await Promise.all([writeFile(clean, 'ordinary file'), writeFile(marked, 'WALLED_SENSITIVE')]);
    await T(async (_electron, files) => {
      const wc = globalThis.__walledTest.views.all.get('perplexity').webContents;
      wc.debugger.attach('1.3');
      try {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument');
        const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#attachment' });
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
      } finally {
        wc.debugger.detach();
      }
    }, [marked, clean]);
    await until(() => readSite('perplexity', 'window.picked.length === 1'), 5000, 'file selection replayed');
    assert.deepEqual(await readSite('perplexity', 'window.picked'), [['clean.txt']]);
  });

  await step('streamed assistant text uses the configured response colour', async () => {
    const colors = await readSite('chatgpt', `(() => {
      document.body.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant"><span id="answer">answer</span></div>'
        + '<div data-message-author-role="user"><span id="question">question</span></div>');
      const expected = document.body.appendChild(document.createElement('span'));
      expected.style.color = ${JSON.stringify(responseColor)};
      return ['answer', 'question'].map(id => getComputedStyle(document.getElementById(id)).color)
        .concat(getComputedStyle(expected).color);
    })()`);
    assert.equal(colors[0], colors[2]);
    assert.notEqual(colors[1], colors[0]);
  });

  await step('the request API inspects JSON supplied by a desktop caller', async () => {
    const decisions = await T(async () => {
      const { backend } = globalThis.__walledTest;
      const inspect = (text) => backend.call('request', {
        site: 'ChatGPT', body_b64: Buffer.from(JSON.stringify({ text })).toString('base64'),
      });
      return [await inspect('ordinary text'), await inspect('WALLED_SENSITIVE')];
    });
    assert.deepEqual(decisions, [{ allow: true }, { allow: false }]);
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

  await step('init_script comes from the shared Python builder (same JS the Playwright mode uses)', async () => {
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
    assert.ok(msg === 'resolved' || /exited|not ready/.test(msg), msg);
    await until(() => T(() => globalThis.__walledTest.backend.status.state === 'ready'), 20000, 'ready again');
  });

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
