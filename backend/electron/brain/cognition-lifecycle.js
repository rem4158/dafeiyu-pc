// One cancellable owner for background cognition; no timers survive service shutdown.
let enabled = false;
let controller = new AbortController();
const timers = new Map();
const work = new Set();
function open() { enabled = true; if (controller.signal.aborted) controller = new AbortController(); }
function track(value) {
  if (!value || typeof value.then !== 'function') return value;
  const task = Promise.resolve(value); work.add(task);
  task.finally(() => work.delete(task)).catch(() => {});
  return task;
}
function invoke(fn, args) {
  if (!enabled) return;
  try { track(fn(...args)); } catch { console.error('[cognition] Background step failed'); }
}
function setTimeoutOwned(fn, delay, ...args) {
  if (!enabled) return null;
  const id = global.setTimeout(() => { timers.delete(id); invoke(fn,args); }, delay);
  timers.set(id, 'timeout'); id.unref?.(); return id;
}
function clearTimeoutOwned(id) { if (id) { global.clearTimeout(id); timers.delete(id); } }
function setIntervalOwned(fn, delay, ...args) {
  if (!enabled) return null;
  const id = global.setInterval(() => invoke(fn,args), delay);
  timers.set(id, 'interval'); id.unref?.(); return id;
}
function clearIntervalOwned(id) { if (id) { global.clearInterval(id); timers.delete(id); } }
function setImmediateOwned(fn, ...args) { return setTimeoutOwned(fn,0,...args); }
async function close() {
  enabled=false; controller.abort();
  for (const [id,kind] of timers) kind==='interval' ? global.clearInterval(id) : global.clearTimeout(id);
  timers.clear();
  await Promise.allSettled([...work]);
}
module.exports = { open, close, track, signal:()=>controller.signal, active:()=>enabled,
  setTimeout:setTimeoutOwned,clearTimeout:clearTimeoutOwned,setInterval:setIntervalOwned,
  clearInterval:clearIntervalOwned,setImmediate:setImmediateOwned,
  status:()=>({active:enabled,timers:timers.size,tasks:work.size}) };
