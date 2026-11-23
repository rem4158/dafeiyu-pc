// Electron is a runtime dependency only: this entry creates no BrowserWindow or tray.
const { app, net, session, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getUserDataRoot } = require('./electron/user-data');

fs.mkdirSync(getUserDataRoot(), { recursive: true });
const runtimeData = path.join(getUserDataRoot(), 'runtime');
fs.mkdirSync(runtimeData, { recursive: true });
app.setPath('userData', runtimeData);
app.setName('大肥鱼 · 念安内核');
app.on('window-all-closed', () => {});
if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(async () => {
  const applyProxy = async proxy => {
    await session.defaultSession.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy }
      : { mode: 'system' });
    await session.defaultSession.closeAllConnections();
  };
  let probeSession;
  const createModelTestFetch = async proxy => {
    // A draft proxy must not change the live Electron session before activation.
    probeSession ??= session.fromPartition('model-connection-test');
    await probeSession.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy } : { mode: 'system' });
    await probeSession.closeAllConnections();
    return (input, options) => probeSession.fetch(input, options);
  };
  await applyProxy(require('./electron/brain/settings').loadSettings().proxy);
  // Chromium networking follows the user's system proxy/Clash settings. Local Qt traffic is separate.
  globalThis.fetch = (input, options) => net.fetch(input, options);
  const backend = await require('./service').createBackend({ onShutdown: () => app.quit(), applyProxy, createModelTestFetch, safeStorage });
  let stopped = false;
  app.on('before-quit', event => {
    if (stopped) return;
    event.preventDefault();
    void backend.close().finally(() => { stopped = true; app.quit(); });
  });
}).catch(() => {
  console.error('[backend] Startup failed. Check the local settings and runtime.');
  app.exit(1);
});
