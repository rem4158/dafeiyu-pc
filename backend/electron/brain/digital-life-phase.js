// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * v7.5 数字生命阶段机
 * Phase A: 打开重逢（依恋主控）
 * Phase C: 桌面陪伴态 proximity burst（替代在线 tick 恒触发）
 */

const { initMemory } = require('./memory');
const { loadSettings } = require('./settings');
const {
  getReunionStrategyByAttachment,
  getAttachmentState,
  getAttachmentQuadrant,
} = require('./digital-life-attachment');
const { sessionGapSynthesis } = require('./digital-life-gap-cognition');
const {
  getDesireVector,
  saveDesireVector,
  computeOutputIntensity,
  getBurstIntervalRange,
} = require('./digital-life-desire');

const SOCIAL_BURST_THRESHOLD = 0.55;
const GRACE_MS_MIN = 45_000;
const GRACE_MS_MAX = 180_000;
const GRACE_MS_BASE = 90_000;

/** @type {{ phaseAComplete: boolean, reunionCompletedAt: number, graceMs: number, hasEffectiveInteraction: boolean, lastSocialBurstAt: number, burstFloorApplied: boolean }} */
let sessionState = createInitialSessionState();

function createInitialSessionState() {
  return {
    phaseAComplete: false,
    reunionCompletedAt: 0,
    graceMs: GRACE_MS_BASE,
    hasEffectiveInteraction: false,
    lastSocialBurstAt: 0,
    burstFloorApplied: false,
  };
}

function resetSessionPhase() {
  sessionState = createInitialSessionState();
  try {
    require('./digital-life-phase-b').resetPhaseBSession();
  } catch {}
}

function getPhaseState() {
  return { ...sessionState };
}

function getDb() {
  return initMemory();
}

function loadPersonalityDims() {
  try {
    return loadSettings().personality?.dimensions || {};
  } catch {
    return {};
  }
}

function loadArchetype() {
  try {
    return loadSettings().personality?.dimensions?.archetype || 'gentle';
  } catch {
    return 'gentle';
  }
}

/**
 * 性格映射 grace 时长：高 dependency/proactivity → 较短；高 possessiveness 反向
 * @param {object} personalityDims
 * @returns {number}
 */
function computePersonalityGraceMs(personalityDims = {}) {
  const dependency = personalityDims.dependency ?? 0.5;
  const proactivity = personalityDims.proactivity ?? 0.5;
  const possessiveness = personalityDims.possessiveness ?? 0.5;

  const adjustment =
    (0.5 - dependency) * 60_000
    + (0.5 - proactivity) * 40_000
    + (possessiveness - 0.5) * -30_000;

  return Math.max(GRACE_MS_MIN, Math.min(GRACE_MS_MAX, GRACE_MS_BASE + adjustment));
}

function pickStickerForQuadrant(quadrant) {
  const stickerMap = {
    secure: ['开心1', '鲜花', '害羞'],
    anxious: ['抱抱', '想你', '哭哭1'],
    avoidant: ['了解1', '嗯嗯'],
    disorganized: ['疑问1', '害羞'],
  };
  const candidates = stickerMap[quadrant] || stickerMap.secure;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function toneToEmotion(tone) {
  if (!tone) return '开心';
  if (/warm|reassuring|casual/.test(tone)) return '开心';
  if (/gentle|patient/.test(tone)) return '害羞';
  if (/neutral/.test(tone)) return '了解1';
  return '开心';
}

/**
 * Phase A 开场：依恋主控，每次打开必迎
 * @param {number} hoursSinceLastActive
 * @returns {object}
 */
function buildPhaseAOpening(hoursSinceLastActive) {
  const db = getDb();
  const personalityDims = loadPersonalityDims();

  const reunion = getReunionStrategyByAttachment(
    db,
    hoursSinceLastActive,
    'default',
    personalityDims,
  );

  let gapInsight = '';
  if (hoursSinceLastActive >= 2) {
    try {
      const gapResult = sessionGapSynthesis({ db, gapHours: hoursSinceLastActive });
      if (gapResult.insight?.text) {
        gapInsight = gapResult.insight.text;
      }
    } catch (err) {
      console.warn('[DigitalLife:Phase] Gap synthesis for Phase A failed:', err);
    }
  }

  const attachment = getAttachmentState(db);
  const quadrant = getAttachmentQuadrant(attachment.anxiety, attachment.avoidance);
  const sticker = pickStickerForQuadrant(quadrant);

  const finalMessage = gapInsight
    ? `${gapInsight}，${reunion.message}`
    : reunion.message;

  return {
    text: finalMessage,
    message: finalMessage,
    tone: reunion.tone,
    quadrant: reunion.quadrant || quadrant,
    sticker,
    voice: hoursSinceLastActive >= 8,
    emotion: toneToEmotion(reunion.tone),
    source: 'attachment_phase_a',
    warmthIntensity: reunion.warmthIntensity,
  };
}

/**
 * Phase A 完成：进入 grace，社交欲望略降
 */
function completePhaseA() {
  const personalityDims = loadPersonalityDims();
  sessionState.phaseAComplete = true;
  sessionState.reunionCompletedAt = Date.now();
  sessionState.graceMs = computePersonalityGraceMs(personalityDims);
  sessionState.burstFloorApplied = false;

  try {
    const db = getDb();
    const vector = getDesireVector(db);
    vector.social = Math.max(0.15, vector.social * 0.85);
    saveDesireVector(db, vector);
  } catch (err) {
    console.warn('[DigitalLife:Phase] Post Phase A social dip failed:', err);
  }

  console.log(
    `[DigitalLife:Phase] Phase A complete, grace=${Math.round(sessionState.graceMs / 1000)}s`,
  );
}

function recordEffectiveInteraction(source = 'unknown') {
  if (!sessionState.hasEffectiveInteraction) {
    sessionState.hasEffectiveInteraction = true;
    sessionState.burstFloorApplied = false;
    console.log(`[DigitalLife:Phase] Effective interaction recorded (${source})`);
  }
}

function isInGracePeriod(now = Date.now()) {
  if (!sessionState.phaseAComplete) return false;
  if (sessionState.hasEffectiveInteraction) return false;
  return now - sessionState.reunionCompletedAt < sessionState.graceMs;
}

/**
 * 离线/在线 tick 内驱力提案门控：Phase A 未完成或 grace 期内不触发 desire_*
 * @param {number} [now]
 * @returns {{ blocked: boolean, reason?: string }}
 */
function shouldBlockDesireProposals(now = Date.now()) {
  if (!sessionState.phaseAComplete) {
    return { blocked: true, reason: 'phase_a_pending' };
  }
  if (isInGracePeriod(now)) {
    return { blocked: true, reason: 'grace_period' };
  }
  return { blocked: false };
}

function isProximityUnmet(now = Date.now()) {
  if (!sessionState.phaseAComplete) return false;
  if (sessionState.hasEffectiveInteraction) return false;
  return now - sessionState.reunionCompletedAt >= sessionState.graceMs;
}

function computeBurstFloor(attachment, personalityDims = {}) {
  const anxiety = attachment?.anxiety ?? 0.5;
  const dependency = personalityDims.dependency ?? 0.5;
  return Math.min(0.85, 0.48 + anxiety * 0.22 + dependency * 0.12);
}

function applyProximityBurstFloor(db, attachment, personalityDims) {
  if (sessionState.burstFloorApplied) return;
  const floor = computeBurstFloor(attachment, personalityDims);
  const vector = getDesireVector(db);
  if (vector.social < floor) {
    vector.social = floor;
    saveDesireVector(db, vector);
    console.log(`[DigitalLife:Phase] proximity burst floor applied: social=${floor.toFixed(3)}`);
  }
  sessionState.burstFloorApplied = true;
}

function computeRefractoryPeriodMs(outputIntensity, personalityDims = {}, attachment = {}) {
  const archetype = loadArchetype();
  const [minMs, maxMs] = getBurstIntervalRange(archetype);
  const scaled = minMs + (1 - outputIntensity) * (maxMs - minMs);
  const anxiety = attachment.anxiety ?? 0.5;
  const anxietyFactor = 1 - (anxiety - 0.5) * 0.35;
  const proactivity = personalityDims.proactivity ?? 0.5;
  const proactivityFactor = 1 - (proactivity - 0.5) * 0.2;
  return Math.round(scaled * anxietyFactor * proactivityFactor);
}

function recordPhaseCSocialBurst() {
  sessionState.lastSocialBurstAt = Date.now();
  sessionState.burstFloorApplied = false;
}

/** @internal smoke tests only */
function advancePastGraceForSmoke() {
  sessionState.reunionCompletedAt = Date.now() - sessionState.graceMs - 5000;
  sessionState.burstFloorApplied = false;
}

/**
 * Phase C 桌面陪伴态：proximity unmet + social burst（非 tick 恒触发）
 * @param {object} [options]
 * @returns {{ shouldTrigger: boolean, desireType?: string, desireValue?: number, threshold?: number, reason?: string, outputIntensity?: number, online?: boolean, phaseC?: boolean }}
 */
function checkPhaseCDesireBurst(options = {}) {
  const isOnline = options.isOnline ?? false;
  const isDesktopVisible = options.isDesktopVisible ?? false;
  const personalityDims = options.personalityDims || loadPersonalityDims();

  if (!isOnline || !isDesktopVisible) {
    return { shouldTrigger: false, reason: 'not_phase_c' };
  }

  if (!sessionState.phaseAComplete) {
    return { shouldTrigger: false, reason: 'phase_a_pending' };
  }

  if (isInGracePeriod()) {
    return { shouldTrigger: false, reason: 'grace_period' };
  }

  if (sessionState.hasEffectiveInteraction) {
    return { shouldTrigger: false, reason: 'effective_interaction' };
  }

  if (!isProximityUnmet()) {
    return { shouldTrigger: false, reason: 'proximity_not_unmet' };
  }

  const db = getDb();
  const attachment = getAttachmentState(db);
  applyProximityBurstFloor(db, attachment, personalityDims);

  const vector = getDesireVector(db);
  const socialValue = vector.social ?? 0;
  const outputIntensity = computeOutputIntensity(vector, personalityDims);

  if (socialValue < SOCIAL_BURST_THRESHOLD) {
    return {
      shouldTrigger: false,
      reason: 'social_below_burst_threshold',
      maxDesire: socialValue,
      threshold: SOCIAL_BURST_THRESHOLD,
      outputIntensity,
    };
  }

  const refractoryMs = computeRefractoryPeriodMs(outputIntensity, personalityDims, attachment);
  const sinceLastBurst = Date.now() - sessionState.lastSocialBurstAt;
  if (sessionState.lastSocialBurstAt > 0 && sinceLastBurst < refractoryMs) {
    return {
      shouldTrigger: false,
      reason: 'refractory_period',
      remainingMs: refractoryMs - sinceLastBurst,
      outputIntensity,
    };
  }

  return {
    shouldTrigger: true,
    desireType: 'social',
    desireValue: socialValue,
    threshold: SOCIAL_BURST_THRESHOLD,
    outputIntensity,
    online: true,
    phaseC: true,
    reason: 'proximity_burst',
  };
}

module.exports = {
  resetSessionPhase,
  getPhaseState,
  computePersonalityGraceMs,
  buildPhaseAOpening,
  completePhaseA,
  recordEffectiveInteraction,
  isInGracePeriod,
  shouldBlockDesireProposals,
  isProximityUnmet,
  checkPhaseCDesireBurst,
  recordPhaseCSocialBurst,
  computeRefractoryPeriodMs,
  advancePastGraceForSmoke,
  SOCIAL_BURST_THRESHOLD,
};
