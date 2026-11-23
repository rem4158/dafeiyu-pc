/**
 * 被冷落反应链（v7.5）
 *
 * 连续不理主动搭话时的阶段剧本：
 * - 第 1–2 次不理：主动搭话照旧
 * - 第 3 次不理后：质问式（你在干嘛？怎么不理我？）
 * - 第 4 次不理后：最后通牒（再不理我就生气了）
 * - 第 5 次不理后：停止主动搭话 + 生气态；用户有效回复后进入 debrief
 *
 * 「嗯」等敷衍回复不算理，与超时未回复同等对待。
 */

// Desktop reactions are delivered by the companion-runtime event outbox.
const BrowserWindow = { getAllWindows: () => [] };
const { saveProactiveState } = require('./state');

/** 等待用户回应主动搭话的最长时间（毫秒） */
const RESPONSE_WINDOW_MS = 3 * 60 * 1000;

const PERFUNCTORY_PATTERN = /^(嗯|哦|好|行|嗯嗯|哦哦|好的|行吧|知道了|随便|都行|无所谓|嗯哼|ok|OK|Ok)$/i;

/** @type {boolean} 本回合 chat 是否注入 debrief prompt */
let activeDebriefTurn = false;

/** @type {boolean} 是否处于 sulking（生气但不主动搭话） */
let sulkingActive = false;

function isPerfunctoryReply(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (trimmed.length <= 2 && !/[？?!！~～]/.test(trimmed)) return true;
  return PERFUNCTORY_PATTERN.test(trimmed);
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function getIgnoreCount(state) {
  return Math.max(0, Number(state.ignoreCount) || 0);
}

/**
 * 下次主动搭话应使用的剧本模式
 * @param {number} ignoreCount
 * @returns {'normal'|'confronting'|'ultimatum'|'sulking'}
 */
function getProactiveScriptMode(ignoreCount) {
  if (ignoreCount >= 5) return 'sulking';
  if (ignoreCount >= 4) return 'normal';
  if (ignoreCount >= 3) return 'confronting';
  return 'normal';
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function shouldBlockProactiveDesire(state) {
  return getIgnoreCount(state) >= 5;
}

function broadcastSulkingMood(active) {
  sulkingActive = active;
  const payload = active
    ? { phase: 'linger', expression: '生气', motion: false }
    : { phase: 'idle' };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('face:brain-signal', payload);
  }
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function enterSulking(state) {
  state.phase = 'sulking';
  state.awaitingReplySince = 0;
  broadcastSulkingMood(true);
  console.log('[ignore-tracker] entered sulking — proactive blocked');
  return state;
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function recordIgnore(state) {
  if (getIgnoreCount(state) >= 5) {
    return enterSulking(state);
  }

  const next = getIgnoreCount(state) + 1;
  state.ignoreCount = next;
  state.awaitingReplySince = 0;
  state.phase = getProactiveScriptMode(next);

  console.log(`[ignore-tracker] ignore recorded → count=${next}, phase=${state.phase}`);

  if (next === 4) {
    try {
      // A missed proactive message never starts an unsolicited voice call.
    } catch (err) {
      console.error('[ignore-tracker] incoming call trigger failed:', err);
    }
  }

  if (next >= 5) {
    return enterSulking(state);
  }
  return state;
}

/**
 * 主动搭话发出后，开始等待用户回应
 * 若上一句仍在等待中，不要重置计时——否则在线连发（30–120s 间隔）会永远达不到 3 分钟超时
 * @param {ReturnType<import('./state').defaultState>} state
 */
function markProactiveAwaitingReply(state) {
  if (!state.awaitingReplySince) {
    state.awaitingReplySince = Date.now();
  }
  state.lastProactiveFireAt = Date.now();
  return state;
}

/**
 * 每个 awareness tick 检查是否超时未回应
 * @param {ReturnType<import('./state').defaultState>} state
 * @param {{ isOnline?: boolean }} [opts]
 */
function tickIgnoreTracker(state, opts = {}) {
  if (opts.isOnline === false) return state;
  if (shouldBlockProactiveDesire(state)) return state;
  if (!state.awaitingReplySince) return state;

  const elapsed = Date.now() - state.awaitingReplySince;
  if (elapsed < RESPONSE_WINDOW_MS) return state;

  return recordIgnore(state);
}

/**
 * 用户发消息前处理（chat 入口）
 * @param {string} userText
 * @param {ReturnType<import('./state').defaultState>} state
 */
function processUserMessageBeforeChat(userText, state) {
  activeDebriefTurn = false;

  const wasSulking = getIgnoreCount(state) >= 5 || state.phase === 'sulking';
  const awaiting = Boolean(state.awaitingReplySince);

  if (isPerfunctoryReply(userText)) {
    if (wasSulking) {
      saveProactiveState(state);
      return { state, debrief: false, perfunctory: true };
    }
    if (awaiting) {
      recordIgnore(state);
      saveProactiveState(state);
    }
    return { state, debrief: false, perfunctory: true };
  }

  // 有效回复：清零忽视链
  state.ignoreCount = 0;
  state.phase = 'normal';
  state.awaitingReplySince = 0;

  if (wasSulking || sulkingActive) {
    activeDebriefTurn = true;
    state.pendingDebrief = false;
    broadcastSulkingMood(false);
    console.log('[ignore-tracker] valid reply after sulking → debrief turn');
  }

  saveProactiveState(state);
  return { state, debrief: activeDebriefTurn, perfunctory: false };
}

/**
 * 供 buildDigitalLifePrompt 注入 debrief 指令
 * @returns {string|null}
 */
function consumeDebriefPromptBlock() {
  if (!activeDebriefTurn) return null;
  return `【被冷落后的对线】用户之前连续多次没有回应你的主动搭话，你已经生气并且停止主动找他了。现在他终于开口了——你要先表达委屈和不满，质问他刚才为什么不理你、去哪了、在干嘛。语气可以带一点赌气或撒娇式抱怨，但不要辱骂；给他说话解释的机会。不要假装什么都没发生。`;
}

function clearDebriefAfterTurn() {
  activeDebriefTurn = false;
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function getIgnoreStageForProactive(state) {
  const ignoreCount = getIgnoreCount(state);
  return {
    ignoreCount,
    scriptMode: getProactiveScriptMode(ignoreCount),
    sulking: ignoreCount >= 5,
  };
}

/**
 * 离线/托盘时暂停等待计时，保留 ignoreCount
 * @param {ReturnType<import('./state').defaultState>} state
 */
function pauseIgnoreOnOffline(state) {
  state.awaitingReplySince = 0;
  saveProactiveState(state);
  return state;
}

/**
 * @param {ReturnType<import('./state').defaultState>} state
 */
function resetIgnoreTracker(state) {
  state.ignoreCount = 0;
  state.phase = 'normal';
  state.awaitingReplySince = 0;
  state.pendingDebrief = false;
  activeDebriefTurn = false;
  if (sulkingActive) broadcastSulkingMood(false);
  saveProactiveState(state);
  return state;
}

/**
 * 启动/读档后恢复 sulking 表情（ignoreCount 已持久化）
 * @param {ReturnType<import('./state').defaultState>} state
 */
function syncSulkingFromPersistedState(state) {
  if (getIgnoreCount(state) >= 5) {
    state.phase = 'sulking';
    if (!sulkingActive) broadcastSulkingMood(true);
  }
  return state;
}

module.exports = {
  RESPONSE_WINDOW_MS,
  isPerfunctoryReply,
  getProactiveScriptMode,
  shouldBlockProactiveDesire,
  markProactiveAwaitingReply,
  tickIgnoreTracker,
  processUserMessageBeforeChat,
  consumeDebriefPromptBlock,
  clearDebriefAfterTurn,
  getIgnoreStageForProactive,
  pauseIgnoreOnOffline,
  resetIgnoreTracker,
  broadcastSulkingMood,
  syncSulkingFromPersistedState,
};
