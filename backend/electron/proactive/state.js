const fs = require('fs');
const path = require('path');
const { userFilePath, getUserDataRoot, getActiveUserId } = require('../user-data');

function statePath() {
  const userId = getActiveUserId();
  if (userId) {
    return userFilePath('proactive-state.json', userId);
  }
  return path.join(getUserDataRoot(), 'proactive-state.json');
}

function defaultState() {
  return {
    dailyDate: '',
    dailyCount: 0,
    lastFireAt: 0,
    returnFiredThisEpisode: false,
    longFocusFiredFor: null,
    longFocusFiredAtFocusMin: 0,
    checkInFiredThisSession: false,
    /** 连续忽视主动搭话次数（0–5） */
    ignoreCount: 0,
    /** normal | confronting | ultimatum | sulking */
    phase: 'normal',
    /** 最近一次主动搭话后等待用户回应的起始时间 */
    awaitingReplySince: 0,
    lastProactiveFireAt: 0,
    pendingDebrief: false,
  };
}

function loadProactiveState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

/**
 * @param {ReturnType<typeof defaultState>} state
 */
function saveProactiveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * @param {ReturnType<typeof defaultState>} state
 */
function resetDailyIfNeeded(state) {
  const today = new Date().toDateString();
  if (state.dailyDate !== today) {
    state.dailyDate = today;
    state.dailyCount = 0;
  }
}

module.exports = { loadProactiveState, saveProactiveState, resetDailyIfNeeded };
