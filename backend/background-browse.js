'use strict';

const { isPost, secureUrl, isAutonomousBlocked } = require('./browser/sites');

const supportedSites = new Set(['xiaohongshu', 'zhihu']);
const authBlocks = new Set(['login_required', 'verification_required']);
const taskStates = new Set(['active', 'paused', 'stopped']);
const maxRecentUrls = 24;
const defaultIntervalMinutes = 5;
const legacyIntervalMs = 15 * 60000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validConnectionKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function taskError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validSites(sites) {
  return Array.isArray(sites) && sites.length > 0 && sites.length <= supportedSites.size &&
    new Set(sites).size === sites.length && sites.every(site => supportedSites.has(site));
}

function validInstruction(value) {
  return typeof value === 'string' && value.length <= 1024 && Array.from(value).length <= 512;
}

function publicSources(values, sites) {
  const urls = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 512) continue;
    const url = secureUrl(value);
    if (!sites.some(site => isPost(site, url))) continue;
    urls.add(url.origin + url.pathname);
    if (urls.size >= maxRecentUrls) break;
  }
  return [...urls];
}

function validBlocks(values, sites, now) {
  const bySite = new Map();
  for (const value of values) {
    if (!value || !sites.includes(value.site)) continue;
    if (authBlocks.has(value.kind)) bySite.set(value.site, { site: value.site, kind: value.kind });
    else if (value.kind === 'rate_limited') {
      const retryAt = Number.isSafeInteger(value.retryAt) ? value.retryAt : now + 5 * 60000;
      if (retryAt > now) bySite.set(value.site, { site: value.site, kind: value.kind, retryAt });
    }
  }
  return [...bySite.values()];
}

function createBackgroundBrowse({ db, getSettings, isBusy = () => false, isConfigured = () => true,
  runBatch, publish, now = Date.now, intervalMs, pollMs = 30000 } = {}) {
  if (!db || typeof getSettings !== 'function' || typeof runBatch !== 'function' ||
      (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs < 1)) ||
      !Number.isSafeInteger(pollMs) || pollMs < 1)
    throw new Error('Invalid background browsing dependencies');

  db.exec(`CREATE TABLE IF NOT EXISTS pc_background_browse (
    id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL
  )`);
  const read = db.prepare('SELECT state_json FROM pc_background_browse WHERE id=1');
  const write = db.prepare(`INSERT INTO pc_background_browse(id,state_json) VALUES(1,?)
    ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json`);

  function load() {
    const stored = read.get()?.state_json;
    if (!stored || stored.length > 20000) return null;
    try {
      const task = JSON.parse(stored);
      if (!task || !validId(task.taskId) || !validId(task.sessionId) || !validSites(task.sites) ||
          !validInstruction(task.instruction) || !taskStates.has(task.status) ||
          !Number.isSafeInteger(task.batches) || task.batches < 0 ||
          (task.status === 'active' && !Number.isSafeInteger(task.nextAt)) ||
          (task.connectionKey !== undefined && !validConnectionKey(task.connectionKey))) return null;
      return { ...task, recentUrls: publicSources(Array.isArray(task.recentUrls) ? task.recentUrls : [], task.sites),
        siteBlocks: validBlocks(Array.isArray(task.siteBlocks) ? task.siteBlocks : [], task.sites, now()) };
    } catch { return null; }
  }

  let task = load();
  if (task?.status === 'active' && task.intervalAnchorAt === undefined && task.nextAt > now()) {
    // Older tasks stored only the deadline with a fixed interval. Keep their
    // last batch time so a changed interval still applies after a restart.
    const anchor = task.nextAt - (intervalMs ?? legacyIntervalMs);
    if (Number.isSafeInteger(task.createdAt) && Number.isSafeInteger(task.updatedAt) &&
        anchor >= task.createdAt && anchor <= task.updatedAt) {
      task.intervalAnchorAt = anchor;
      write.run(JSON.stringify(task));
    }
  }
  let started = false, closing = false, timer, inFlight, controller, closePromise;

  function batchIntervalMs() {
    if (intervalMs !== undefined) return intervalMs;
    const minutes = getSettings().browser?.backgroundIntervalMinutes;
    return (Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 120 ? minutes : defaultIntervalMinutes) * 60000;
  }

  function nextBatchAt(value) {
    if (value.status !== 'active') return null;
    return Number.isSafeInteger(value.intervalAnchorAt) ? value.intervalAnchorAt + batchIntervalMs() : value.nextAt;
  }

  function save(value) {
    const next = { ...value, nextAt: nextBatchAt(value), updatedAt: now() };
    write.run(JSON.stringify(next));
    task = next;
  }

  function availableSites(value, at = now()) {
    const blocked = new Set(validBlocks(value.siteBlocks, value.sites, at).map(block => block.site));
    const settings = getSettings();
    return value.sites.filter(site => !blocked.has(site) && !isAutonomousBlocked(settings, site));
  }

  function hasBlockedSite(sites) {
    const settings = getSettings();
    return sites.some(site => isAutonomousBlocked(settings, site));
  }

  function assertSitePolicy(sites) {
    if (hasBlockedSite(sites))
      throw taskError('browser_site_blacklisted', '任务包含禁止自主访问的网站，请在浏览器设置中解除后再继续。', 409);
  }

  function refreshSitePolicy() {
    if (!task || !hasBlockedSite(task.sites)) return;
    if (task.status === 'active')
      save({ ...task, status: 'paused', pauseReason: 'site_blacklisted', nextAt: null });
    return interrupt();
  }

  function snapshot(value, includeConnection = false) {
    const { connectionKey, intervalAnchorAt, ...publicTask } = value;
    const siteBlocks = validBlocks(value.siteBlocks, value.sites, now());
    return { ...publicTask, nextAt: nextBatchAt(value), sites: [...value.sites], recentUrls: [...value.recentUrls], siteBlocks,
      availableSites: availableSites(value), ...(includeConnection && connectionKey && { connectionKey }) };
  }

  function availability() {
    if (getSettings().browser?.enabled === false) return 'browser_disabled';
    if (!isConfigured()) return 'not_configured';
    if (isBusy()) return 'foreground_busy';
    return null;
  }

  function reason(nextAt = task && nextBatchAt(task)) {
    if (!task) return 'no_task';
    if (task.status === 'stopped') return 'stopped';
    if (task.status === 'paused') return task.pauseReason;
    if (!started || closing) return 'not_running';
    if (inFlight) return 'reading';
    const blocked = availability();
    if (blocked) return blocked;
    if (!availableSites(task).length) return 'sites_blocked';
    return nextAt > now() ? 'scheduled' : 'ready';
  }

  function status() {
    refreshSitePolicy();
    const current = task && snapshot(task);
    const retryTimes = current?.siteBlocks.filter(block => block.kind === 'rate_limited').map(block => block.retryAt) || [];
    const nextEligibleAt = current?.status === 'active' && (current.availableSites.length || retryTimes.length)
      ? Math.max(current.nextAt, current.availableSites.length ? 0 : Math.min(...retryTimes)) : null;
    return { task: current, running: started && !closing, working: Boolean(inFlight), reason: reason(current?.nextAt), nextEligibleAt };
  }

  function createTask({ taskId, sessionId, sites, instruction = '', connectionKey } = {}) {
    if (!validId(taskId) || !validId(sessionId) || !validSites(sites) || !validInstruction(instruction) ||
        (connectionKey !== undefined && !validConnectionKey(connectionKey)))
      throw taskError('background_browse_invalid_task', '后台浏览只接受本轮用户授权的小红书或知乎和简短公开主题。');
    if (closing) throw taskError('background_browse_unavailable', '后台正在关闭。', 409);
    if (task?.taskId === taskId) return status();
    if (task && task.status !== 'stopped')
      throw taskError('background_browse_task_active', '已有一项后台浏览任务，请先停止它。', 409);
    if (getSettings().browser?.enabled === false)
      throw taskError('browser_disabled', '网页浏览功能已关闭。', 409);
    assertSitePolicy(sites);
    const at = now();
    save({ taskId, sessionId, sites: [...sites], instruction: instruction.trim(),
      ...(connectionKey && { connectionKey }), createdAt: at, status: 'active',
      nextAt: at, intervalAnchorAt: null, batches: 0, recentUrls: [], siteBlocks: [] });
    return status();
  }

  function assertTaskId(taskId) {
    if (taskId !== undefined && (!validId(taskId) || task?.taskId !== taskId))
      throw taskError('background_browse_task_changed', '这项后台浏览任务已更换，请先核对当前任务。', 409);
  }

  function interrupt() {
    controller?.abort();
    return inFlight;
  }

  function stopTask(taskId) {
    assertTaskId(taskId);
    if (task && task.status !== 'stopped') {
      save({ ...task, status: 'stopped', stopReason: 'user', pauseReason: undefined, nextAt: null });
    }
    interrupt();
    return status();
  }

  function resumeTask(taskId) {
    assertTaskId(taskId);
    if (!task || task.status === 'stopped')
      throw taskError('background_browse_no_task', '没有可继续的后台浏览任务。', 409);
    if (closing) throw taskError('background_browse_unavailable', '后台正在关闭。', 409);
    assertSitePolicy(task.sites);
    const siteBlocks = validBlocks(task.siteBlocks, task.sites, now()).filter(block => block.kind === 'rate_limited');
    if (task.status === 'paused' || siteBlocks.length !== validBlocks(task.siteBlocks, task.sites, now()).length) {
      save({ ...task, status: 'active', pauseReason: undefined, budgetError: undefined, nextAt: now(), intervalAnchorAt: null, siteBlocks });
    }
    return status();
  }

  function clearSiteBlock(site) {
    if (!task || task.status === 'stopped' || !task.siteBlocks.some(block => block.site === site && authBlocks.has(block.kind))) return false;
    save({ ...task, siteBlocks: task.siteBlocks.filter(block => block.site !== site || !authBlocks.has(block.kind)) });
    return true;
  }

  function isWorking() { return Boolean(inFlight); }

  function ownsTask(taskId) {
    return task?.taskId === taskId && task.status === 'active';
  }

  async function run(current, signal) {
    refreshSitePolicy();
    if (signal.aborted || !ownsTask(current.taskId) || availability()) return { reason: 'interrupted', published: false };
    // Reserve the next time before the model call. A cancelled or crashed batch
    // never catches up by issuing another request immediately on restart.
    save({ ...task, intervalAnchorAt: now() });
    let result;
    try {
      result = await runBatch(current, { signal });
    } catch (error) {
      if (signal.aborted || !ownsTask(current.taskId) || closing) return { reason: 'interrupted', published: false };
      const code = typeof error?.code === 'string' ? error.code : '';
      const budgetBlocked = /^usage_budget_[a-z_]{1,60}$/.test(code);
      const pauseReason = budgetBlocked ? 'budget_blocked' : code === 'background_browse_connection_changed' ? 'connection_changed' : null;
      if (pauseReason) {
        save({ ...task, status: 'paused', pauseReason, nextAt: null, ...(budgetBlocked && { budgetError: code }) });
      } else save({ ...task, lastOutcome: 'generation_failed' });
      return { reason: pauseReason || 'generation_failed', published: false };
    }
    refreshSitePolicy();
    if (signal.aborted || closing || !ownsTask(current.taskId) || availability()) return { reason: 'interrupted', published: false };

    const at = now();
    const sources = Array.isArray(result?.recentUrls) ? result.recentUrls.slice(0, maxRecentUrls) : [];
    const blocks = Array.isArray(result?.siteBlocks) ? validBlocks(result.siteBlocks.slice(0, 8), current.availableSites, at) : [];
    const existingBlocks = validBlocks(task.siteBlocks, task.sites, at);
    const siteBlocks = validBlocks([...existingBlocks, ...blocks], task.sites, at);
    const stopped = result?.stop === true;
    save({ ...task, recentUrls: publicSources([...sources, ...task.recentUrls], task.sites), siteBlocks,
      batches: task.batches + 1, status: stopped ? 'stopped' : 'active',
      intervalAnchorAt: stopped ? null : at,
      ...(stopped && { stopReason: 'model' }), lastOutcome: 'completed' });

    // Checkpoint progress before any optional delivery. A crash cannot cause
    // the same batch to publish again from this durable state.
    if (!publish || !result?.summary || signal.aborted || closing || availability())
      return { reason: stopped ? 'stopped' : 'completed', published: false };
    try {
      await publish(current, result.summary, { signal });
      return { reason: stopped ? 'stopped' : 'completed', published: true };
    } catch {
      return { reason: signal.aborted ? 'interrupted' : 'publish_failed', published: false };
    }
  }

  async function tick() {
    refreshSitePolicy();
    const at = reason();
    if (at !== 'ready') return { reason: at, published: false };
    const current = snapshot(task, true);
    controller = new AbortController();
    const { signal } = controller;
    inFlight = Promise.resolve().then(() => run(current, signal));
    try { return await inFlight; }
    finally { inFlight = undefined; controller = undefined; }
  }

  function start() {
    if (started || closing) return;
    started = true;
    refreshSitePolicy();
    timer = setInterval(() => { void tick().catch(() => console.error('[background-browse] Scheduled batch failed')); }, pollMs);
    timer.unref?.();
  }

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    started = false;
    clearInterval(timer);
    const pending = interrupt();
    closePromise = Promise.allSettled(pending ? [pending] : []).then(() => {});
    return closePromise;
  }

  return { start, close, interrupt, tick, createTask, status, stopTask, resumeTask, clearSiteBlock, refreshSitePolicy, isWorking };
}

module.exports = { createBackgroundBrowse };
