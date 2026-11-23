'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { siteNames: sites } = require('./sites');
const validCode = /^[A-Za-z0-9]{4,10}$/;
function problem(code, status) {
  return Object.assign(new Error(code), { code, status });
}
function cancelled() { return new DOMException('Browser task cancelled', 'AbortError'); }

function createBrowserAuth({ credentialFile, safeStorage, onChallengeEnd, now = Date.now,
  expireMs = 600000 } = {}) {
  const temporary = new Map();
  let active = null;
  let closed = false;

  function canRemember() {
    try {
      return Boolean(credentialFile && safeStorage?.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text'));
    } catch { return false; }
  }
  function readVault() {
    if (!credentialFile) return {};
    try {
      if (fs.statSync(credentialFile).size > 256 * 1024) throw new Error();
      const vault = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
      if (!vault || typeof vault !== 'object' || Array.isArray(vault) ||
          !Object.entries(vault).every(([site, data]) => Object.hasOwn(sites, site) && typeof data === 'string')) throw new Error();
      return vault;
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw problem('browser_credentials_unavailable', 503);
    }
  }
  function writeVault(vault) {
    const tmp = credentialFile + '.tmp-' + crypto.randomUUID();
    try {
      fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(vault), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, credentialFile);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* No temporary file to remove. */ }
      throw problem('browser_credentials_unavailable', 503);
    }
  }
  function accountStatus() {
    const remembered = Object.keys(readVault());
    return { sites: [...new Set([...temporary.keys(), ...remembered])], remembered, canRemember: canRemember() };
  }
  function setCredentials({ site, username, password, remember = false } = {}) {
    if (!Object.hasOwn(sites, site) || typeof username !== 'string' || typeof password !== 'string' ||
        typeof remember !== 'boolean' || username.length > 256 || password.length > 512 ||
        (!username.trim() && password) || (site === 'weibo' && username.trim())) throw problem('browser_credentials_invalid', 400);
    const value = { username: username.trim(), password };
    const vault = readVault();
    if (value.username && remember) {
      if (!canRemember()) throw problem('browser_credentials_unavailable', 503);
      try { vault[site] = safeStorage.encryptString(JSON.stringify(value)).toString('base64'); }
      catch { throw problem('browser_credentials_unavailable', 503); }
      writeVault(vault);
      temporary.delete(site);
    } else {
      if (Object.hasOwn(vault, site)) { delete vault[site]; writeVault(vault); }
      if (value.username) temporary.set(site, value);
      else temporary.delete(site);
    }
    return accountStatus();
  }
  function getCredentials({ site }) {
    if (!Object.hasOwn(sites, site)) return null;
    if (temporary.has(site)) return { ...temporary.get(site) };
    const encrypted = readVault()[site];
    if (!encrypted) return null;
    try {
      if (!canRemember()) throw new Error();
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch { throw problem('browser_credentials_unavailable', 503); }
  }

  function finish(task, error, value) {
    if (task !== active) return;
    active = null;
    clearTimeout(task.expiration);
    task.signal?.removeEventListener('abort', task.stop);
    onChallengeEnd?.(task.info);
    if (error) task.reject(error);
    else task.resolve(value);
  }
  function pending() {
    if (active && now() >= active.info.expiresAt) finish(active, problem('browser_challenge_expired', 410));
    return active ? { ...active.info } : null;
  }
  function start({ site, method, signal }) {
    if (closed || signal?.aborted) return Promise.reject(cancelled());
    if (!Object.hasOwn(sites, site) || !['sms', 'email', 'manual'].includes(method)) {
      return Promise.reject(problem('browser_challenge_invalid', 400));
    }
    if (pending()) return Promise.reject(problem('browser_challenge_busy', 409));
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(6).toString('hex');
      const info = { id, site, method, expiresAt: now() + expireMs };
      const task = { info, signal, resolve, reject };
      active = task;
      task.stop = () => finish(task, cancelled());
      signal?.addEventListener('abort', task.stop, { once: true });
      task.expiration = setTimeout(() => finish(task, problem('browser_challenge_expired', 410)), expireMs);

    });
  }
  function submit({ id, code, confirmed } = {}) {
    if (!pending() || active.info.id !== id) throw problem('browser_challenge_gone', 410);
    if (active.info.method === 'manual') {
      if (confirmed !== true) throw problem('browser_challenge_invalid', 400);
      finish(active, null);
    } else {
      if (typeof code !== 'string' || !validCode.test(code.trim())) throw problem('browser_challenge_invalid', 400);
      finish(active, null, code.trim());
    }
    return { accepted: true };
  }
  function cancel({ id } = {}) {
    if (!pending() || active.info.id !== id) throw problem('browser_challenge_gone', 410);
    finish(active, problem('browser_challenge_declined', 409));
    return { cancelled: true };
  }
  function close() {
    closed = true;
    if (active) finish(active, cancelled());
    temporary.clear();
  }
  return { getCredentials, setCredentials, accountStatus, requestCode: start,
    onManualChallenge: ({ site, signal }) => start({ site, signal, method: 'manual' }),
    pending, submit, cancel, close };
}
module.exports = { createBrowserAuth };
