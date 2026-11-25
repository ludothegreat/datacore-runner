'use strict';

// Desktop wrapper that turns the web page into a Windows screensaver. A .scr file is a normal
// program that Windows starts with /s (run), /p (preview) or /c (settings); see args.cjs.
// The page is served from inside the app over a private app:// address, so nothing listens on
// the network. The same address answers /api/stats, which the page's stats panel polls.

const { app, BrowserWindow, ipcMain, protocol, screen, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('./args.cjs');

const WEB_ROOT = path.join(__dirname, 'web');
const ORIGIN = 'app://datacore';
const DEFAULT_CONFIG = { corrupt: false, stats: false, primaryOnly: false, diag: false, scale: 0 };
// Set by the build's smoke test: load, report what the page is doing, press a key, expect to quit.
const SMOKE = process.env.DATACORE_SMOKE === '1';

app.setName('Datacore Runner');
const args = parseArgs(process.argv.slice(1));

// ---------------------------------------------------------------- logging
// A screensaver has no console, so everything goes to a file next to the settings.

const LOG_FILE = path.join(app.getPath('userData'), 'datacore.log');
/** @param {string} level @param {unknown[]} parts */
function writeLog(level, parts) {
  const line = `${new Date().toISOString()} ${level} ${parts.map((p) => (p instanceof Error ? p.stack : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  if (SMOKE || !app.isPackaged) process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    process.stderr.write(`cannot write ${LOG_FILE}: ${err}\n${line}`);
  }
}
const log = {
  debug: (/** @type {unknown[]} */ ...p) => writeLog('DEBUG', p),
  info: (/** @type {unknown[]} */ ...p) => writeLog('INFO', p),
  error: (/** @type {unknown[]} */ ...p) => writeLog('ERROR', p),
};
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // One run's worth of history is enough; keep the file from growing for ever.
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.truncateSync(LOG_FILE);
} catch (err) {
  process.stderr.write(`cannot prepare ${LOG_FILE}: ${err}\n`);
}
process.on('uncaughtException', (err) => { log.error('uncaught', err); app.exit(1); });
process.on('unhandledRejection', (err) => { log.error('unhandled rejection', err); });
log.info('start', { argv: process.argv.slice(1), mode: args.mode, version: app.getVersion(), electron: process.versions.electron, platform: process.platform });

// ---------------------------------------------------------------- settings

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      corrupt: raw.corrupt === true, stats: raw.stats === true, primaryOnly: raw.primaryOnly === true,
      // Troubleshooting keys, set by hand in config.json, not shown in the settings window.
      diag: raw.diag === true,
      scale: typeof raw.scale === 'number' && raw.scale > 0 ? raw.scale : 0,
    };
  } catch (err) {
    log.error('settings file unreadable, using defaults', CONFIG_FILE, err);
    return { ...DEFAULT_CONFIG };
  }
}

/** @param {unknown} cfg */
function saveConfig(cfg) {
  const c = /** @type {Record<string, unknown>} */ (cfg ?? {});
  // The settings window only knows the first three; the hand-set troubleshooting keys are kept.
  const clean = { ...loadConfig(), corrupt: c.corrupt === true, stats: c.stats === true, primaryOnly: c.primaryOnly === true };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2));
  log.info('settings saved', clean);
}

// ---------------------------------------------------------------- PC stats

let cpuPrev = cpuTimes();
let statsAt = 0;
/** @type {Record<string, unknown>} */
let statsSnapshot = {};
let nvidiaMissing = false;
let gpuErrorLogged = '';

function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** @returns {Promise<{gpu: Record<string, unknown> | null, error: string}>} */
function readGpu() {
  if (nvidiaMissing) return Promise.resolve({ gpu: null, error: '' });
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true }, (err, stdout) => {
        if (err) {
          if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
            // No NVIDIA tools on this machine: not an error, and not worth asking again.
            nvidiaMissing = true;
            log.info('nvidia-smi not found, GPU rows disabled');
            resolve({ gpu: null, error: '' });
            return;
          }
          resolve({ gpu: null, error: String(err.message) });
          return;
        }
        const parts = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
        const nums = parts.slice(1).map(Number);
        if (parts.length !== 5 || nums.some(Number.isNaN)) {
          resolve({ gpu: null, error: `unexpected nvidia-smi output: ${stdout.trim().slice(0, 120)}` });
          return;
        }
        resolve({ gpu: { name: parts[0], percent: nums[0], temp_c: nums[1], vram_used_gb: nums[2] / 1024, vram_total_gb: nums[3] / 1024 }, error: '' });
      });
  });
}

async function sampleStats() {
  const now = Date.now();
  if (now - statsAt < 900) return statsSnapshot;
  const first = statsAt === 0;
  statsAt = now;
  const cur = cpuTimes();
  const dBusy = cur.busy - cpuPrev.busy;
  const dTotal = cur.total - cpuPrev.total;
  cpuPrev = cur;
  const { gpu, error } = await readGpu();
  if (error !== gpuErrorLogged) {
    if (error) log.error('GPU read failed', error);
    else log.info('GPU read recovered');
    gpuErrorLogged = error;
  }
  statsSnapshot = {
    // No temperature: Windows has no built-in way to read the CPU's without extra drivers.
    cpu: { percent: first || dTotal <= 0 ? null : (100 * dBusy) / dTotal, temp_c: null },
    memory: { used_gb: (os.totalmem() - os.freemem()) / 2 ** 30, total_gb: os.totalmem() / 2 ** 30 },
    gpu,
    gpu_error: error,
  };
  return statsSnapshot;
}

// ---------------------------------------------------------------- serving the page

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function registerProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/stats') {
      return Response.json(await sampleStats(), { headers: { 'Cache-Control': 'no-store' } });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(WEB_ROOT, rel);
    // Nothing outside the bundled web folder, whatever the address says.
    if (!file.startsWith(WEB_ROOT + path.sep)) {
      log.error('refused path outside web root', url.pathname);
      return new Response('forbidden', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      log.error('cannot serve', url.pathname, err);
      return new Response('not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- windows

/** @type {Map<number, 'saver' | 'config' | 'blank'>} */
const roles = new Map();

/** @param {'saver' | 'config' | 'blank'} role @param {Electron.BrowserWindowConstructorOptions} options */
function makeWindow(role, options) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    ...options,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const id = win.webContents.id;
  roles.set(id, role);
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (event) => {
    // Everything but debug chatter: the page reports resolution changes and lost graphics contexts here.
    if (event.level === 'warning' || event.level === 'error') log.error(`page ${event.level}:`, event.message);
    else if (event.level === 'info') log.info('page:', event.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => { log.error('page process gone', details); app.quit(); });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => { log.error('page failed to load', code, desc, url); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { roles.delete(id); });
  return win;
}

function runSaver() {
  const cfg = loadConfig();
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  log.info('saver', cfg, 'displays', displays.map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor })));
  const query = new URLSearchParams({ mode: 'saver', quiet: '1', stats: cfg.stats ? '1' : '0' });
  if (cfg.corrupt) query.set('corrupt', '1');
  if (cfg.diag) query.set('diag', '1');
  if (cfg.scale > 0) query.set('scale', String(cfg.scale));
  for (const display of displays) {
    const live = !cfg.primaryOnly || display.id === primary.id;
    const win = makeWindow(live ? 'saver' : 'blank', {
      ...display.bounds,
      frame: false, resizable: false, movable: false, minimizable: false, skipTaskbar: true,
      fullscreen: true, hasShadow: false,
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds);
      win.show();
      if (display.id === primary.id) win.focus();
    });
    // If one screen's window goes, the screensaver is over on all of them.
    win.on('closed', () => app.quit());
    win.loadURL(live ? `${ORIGIN}/index.html?${query}` : `${ORIGIN}/blank.html`);
    if (SMOKE && display.id === primary.id) smokeTest(win);
  }
}

function runConfig() {
  const win = makeWindow('config', {
    width: 600, height: 470, useContentSize: true, resizable: false, maximizable: false, fullscreenable: false,
    title: 'Datacore Runner settings', backgroundColor: '#1d2021',
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/config.html`);
  if (SMOKE) {
    // Report what the form shows, flip every setting, press Save. Save closes the window.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const shown = await win.webContents.executeJavaScript(`(() => {
            const read = () => ({
              corrupt: document.querySelector('input[name=mode]:checked')?.value === 'corrupt',
              stats: document.getElementById('stats').checked,
              primaryOnly: document.getElementById('primaryOnly').checked,
            });
            const before = read();
            document.querySelector('input[name=mode][value=' + (before.corrupt ? 'plain' : 'corrupt') + ']').click();
            document.getElementById('stats').click();
            document.getElementById('primaryOnly').click();
            document.getElementById('save').click();
            return before;
          })()`);
          process.stdout.write(`SMOKE-CONFIG shown ${JSON.stringify(shown)}\n`);
        } catch (err) {
          process.stdout.write(`SMOKE-ERROR ${err}\n`);
          app.exit(3);
          return;
        }
        setTimeout(() => { process.stdout.write('SMOKE-ERROR save did not close the window\n'); app.exit(2); }, 4000);
      }, 1500);
    });
  }
}

/** @param {BrowserWindow} win */
function smokeTest(win) {
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const report = await win.webContents.executeJavaScript(`(async () => {
          const stats = await fetch('/api/stats').then((r) => r.json());
          const fatal = document.getElementById('fatal');
          return {
            url: location.search,
            sceneSeconds: window.__game ? window.__game.state.time : null,
            distance: window.__game ? window.__game.state.dist : null,
            fatal: fatal && fatal.style.display === 'block' ? fatal.textContent : '',
            statsPanel: document.getElementById('stats').innerText,
            stats,
          };
        })()`);
        process.stdout.write(`SMOKE ${JSON.stringify(report)}\n`);
      } catch (err) {
        process.stdout.write(`SMOKE-ERROR ${err}\n`);
        app.exit(3);
        return;
      }
      // The real exit path: a key press seen by the page, relayed by the preload script.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
      setTimeout(() => { process.stdout.write('SMOKE-ERROR key press did not quit\n'); app.exit(2); }, 4000);
    }, 6000);
  });
}

// A graphics driver crash or reset takes Chromium's GPU process with it; the picture can go
// blank or wrong for a moment while it restarts. Worth knowing about when a tester reports a flash.
app.on('child-process-gone', (_event, details) => { log.error('child process gone', details); });

ipcMain.on('datacore:role', (event) => { event.returnValue = roles.get(event.sender.id) ?? 'blank'; });
ipcMain.on('datacore:quit', (event) => { log.info('quit requested by', roles.get(event.sender.id)); app.quit(); });
ipcMain.handle('datacore:get-config', () => loadConfig());
ipcMain.handle('datacore:save-config', (_event, cfg) => saveConfig(cfg));

if (args.mode === 'preview') {
  // The tiny preview monitor in the Windows dialog would need drawing into another program's
  // window. Not supported in this build: it stays blank.
  log.info('preview requested, not supported, exiting');
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  log.info('already running, exiting');
  app.exit(0);
} else {
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(() => {
    registerProtocol();
    if (args.mode === 'run') runSaver();
    else runConfig();
  }).catch((err) => { log.error('startup failed', err); app.exit(1); });
}
