'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Main decides what this window is; asking it avoids guessing from the URL.
const role = ipcRenderer.sendSync('datacore:role');

if (role === 'saver') {
  // A screensaver ends on any input. Mouse movement gets a grace period and a small dead zone:
  // Windows reports a phantom move as the window appears, and a nudged desk should not end it.
  const armedAt = Date.now() + 1500;
  /** @type {{x: number, y: number} | null} */
  let origin = null;
  const quit = () => ipcRenderer.send('datacore:quit');
  for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) {
    window.addEventListener(type, quit, { capture: true, passive: true });
  }
  window.addEventListener('mousemove', (e) => {
    if (Date.now() < armedAt) return;
    if (!origin) { origin = { x: e.screenX, y: e.screenY }; return; }
    if (Math.hypot(e.screenX - origin.x, e.screenY - origin.y) > 12) quit();
  }, { capture: true, passive: true });
}

if (role === 'config') {
  contextBridge.exposeInMainWorld('datacore', {
    getConfig: () => ipcRenderer.invoke('datacore:get-config'),
    saveConfig: (/** @type {unknown} */ cfg) => ipcRenderer.invoke('datacore:save-config', cfg),
    close: () => ipcRenderer.send('datacore:quit'),
  });
}
