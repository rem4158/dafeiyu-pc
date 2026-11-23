'use strict';

const { createDailyLifeStore } = require('./daily-life-store');

function dayKey(at) {
  const date = new Date(at);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, '0')).join('-');
}

function localTime(at, value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return NaN;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) return NaN;
  const date = new Date(at);
  date.setHours(hour, minute, 0, 0);
  return date.getHours() === hour && date.getMinutes() === minute ? date.getTime() : NaN;
}

function withWindow(at, entry) {
  const { startTime, endTime, ...details } = entry;
  return { ...details, startAt:localTime(at, startTime), endAt:localTime(at, endTime) };
}

function validWindow(entry, earliest) {
  return entry.startAt >= earliest && entry.endAt > entry.startAt;
}

function createDailyLife({ db, getSettings, isReady, isBusy, getMemory, planActivity, runActivity,
  now = Date.now, pollMs = 15000 }) {
  const store = createDailyLifeStore(db);
  let timer, inFlight, controller, closing = false, retryPlanAt = 0;

  function enabled(settings = getSettings()) {
    return settings.proactive?.enabled === true && settings.proactive.maxPerDay !== 0 &&
      settings.memory?.enabled !== false && settings.browser?.enabled !== false && settings.browser?.proactive !== false;
  }

  function recentExperiences() {
    if (getSettings().memory?.enabled === false) return [];
    return store.recentExperiences(dayKey(now()), 5);
  }

  async function plan(settings, at, day, signal) {
    let entries;
    let failure;
    try {
      const proposed = await planActivity({ settings, at, day, memory: getMemory(settings),
        experiences: store.recentExperiences(day, 5), signal, taskId: `daily-life-${day}` });
      signal.throwIfAborted();
      entries = proposed.map(entry => withWindow(at, entry)).sort((a,b) => a.startAt-b.startAt);
      const earliest = Math.floor(at / 60000) * 60000;
      if (entries.some((entry,index) => !validWindow(entry, earliest) || entry.endAt <= now() ||
        (index > 0 && entries[index-1].endAt > entry.startAt))) failure = 'invalid_window';
    } catch (error) {
      // A provider/validation failure uses today's planning opportunity.
      // Foreground interruption can try again after it has had time to settle.
      failure = error?.code?.startsWith('usage_budget_') ? 'budget_blocked' : 'failed';
    }
    if (signal.aborted) { retryPlanAt = now() + 60000; return; }
    const finishedAt = now();
    if (dayKey(finishedAt) !== day || !enabled()) return;
    if (failure) store.failPlan(day, finishedAt, failure);
    else store.savePlan(day, entries, finishedAt);
  }

  async function run(day, plan, entries, signal) {
    const at = now();
    if (signal.aborted || !store.claim(day, plan.id, at)) return;
    const upcoming = entries.filter(entry => entry.status === 'scheduled' && entry.startAt > at)
      .map(({id, kind, intent, startAt, endAt}) => ({id, kind, intent,
        startTime:new Date(startAt).toTimeString().slice(0,5), endTime:new Date(endAt).toTimeString().slice(0,5)}));
    let result;
    try {
      result = await runActivity({ plan, upcoming, experiences: store.recentExperiences(day, 5),
        remainingMs:plan.endAt-at, signal, taskId: `daily-life-${day}` });
    } catch {
      store.finish(day, plan.id, 'failed', null, now(), { outcome:'failed', actions:[] });
      return;
    }
    const { experience, report } = result;
    const done = ['recorded', 'no_note', 'stopped'].includes(report.outcome);
    const finishedAt = now();
    let adjustment = null;
    const proposed = result.adjustment;
    if (done && !signal.aborted && dayKey(finishedAt) === day && upcoming.some(entry => entry.id === proposed?.id)) {
      const window = withWindow(at, proposed);
      if (validWindow(window, finishedAt)) adjustment = window;
    }
    store.finish(day, plan.id, done ? 'done' : 'failed', experience, finishedAt, report, adjustment);
  }

  async function tick() {
    if (!timer || closing || inFlight) return;
    const at = now(), day = dayKey(at), settings = getSettings();
    store.expireScheduled(at);
    if (!enabled(settings) || !isReady(settings, at) || isBusy()) return;
    const value = store.readDay(day);
    const due = value?.entries.find(entry => entry.kind === 'browse' && entry.status === 'scheduled' && entry.startAt <= at);
    if (value ? !due : retryPlanAt > at) return;
    controller = new AbortController();
    const signal = controller.signal;
    inFlight = Promise.resolve().then(() => {
      if (signal.aborted) return;
      return due ? run(day, due, value.entries, signal) : plan(settings, at, day, signal);
    });
    try { await inFlight; }
    finally { inFlight = undefined; controller = undefined; }
  }

  function start() {
    if (timer || closing) return;
    store.recoverInterrupted(now());
    store.expireScheduled(now());
    timer = setInterval(() => { void tick().catch(() => console.error('[daily-life] Scheduled check failed')); }, pollMs);
    timer.unref?.();
  }

  function interrupt() {
    controller?.abort();
    return inFlight?.catch(() => {});
  }

  async function close() {
    closing = true;
    clearInterval(timer);
    await interrupt();
  }

  return { start, close, tick, interrupt, recentExperiences, isWorking: () => Boolean(inFlight),
    today: () => store.readDay(dayKey(now())) };
}

module.exports = { createDailyLife };
