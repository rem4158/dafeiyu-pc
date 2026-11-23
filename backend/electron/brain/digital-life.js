// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 主模块
 * 整合情绪、漂移、结晶化、依恋子系统
 * Step 6: 新增语言互惠、认知负荷自适应
 * Step 7: 新增元认知系统 + NarrativeGateway
 * Step 8: 新增内稳态系统（元监控）
 */

const { DatabaseSync } = require('node:sqlite');
const {
  EMOTION_KEYS,
  getEmotionVector,
  updateEmotionBaseline,
  updateEmotionBaselineWithInterlocks,
  buildTextTonePrompt,
  getEmotionOutputs,
  applyInterlocks,
  setPauseDecayOnline,
  getEmotionEventSummary,
  analyzeUserEmotion,
  getRecentEmotionEvents,
} = require('./digital-life-emotion');
const { recordMicroDrift, getDriftStats, getRecentDrifts, getCurrentGrowthStage } = require('./digital-life-drift');
const { selectSticker: selectEmotionSticker, EMOTION_TO_STICKER } = require('./digital-life-emotion');
const {
  CRYSTALLIZATION_CONFIG,
  DYNAMIC_CRYSTALLIZATION_CONFIG,
  getDynamicCrystallizationConfig,
  checkCrystallizationEligibility,
  getCurrentNarrative,
  buildIdentityAnchor,
  runCrystallization,
  tryCrystallize,
  getCrystallizationHistory,
  scheduleDeferredCrystallization,
  setOnCrystallizationSuccess,
} = require('./digital-life-crystallize');
const {
  getAttachmentState,
  getAttachmentQuadrant,
  getAttachmentTypeName,
  updateAttachmentState,
  checkAttachmentHealth,
  getReunionStrategyByAttachment,
  recordReunionSignal,
  recordRapidReplySignal,
  recordSilenceSignal,
  updateSeparationState,
  buildAttachmentPrompt,
  getAttachmentReunionToneCandidate,
  getAttachmentOverview,
} = require('./digital-life-attachment');
const {
  initDesireState,
  setDb: setDesireDb,
  updateDesires,
  checkDesireTrigger,
  resetAfterTrigger,
  modulateDesireByEngagement,
  getDesireToneCandidate,
  getDesireInfluenceOnTone,
  getDesireOverview,
  getDesireBehavior,
  getDesireVector,
  DESIRE_KEYS,
  setOnlineState,
  getOnlineState,
  applyOnlineNoise,
  getBurstIntervalRange,
  getRecentDesireTriggerCount,
} = require('./digital-life-desire');
// Step 6: 语言互惠 + 认知负荷自适应
const { matchLinguisticStyle, getLinguisticToneCandidate, analyzeUserStyleFromHistory, analyzeUserStyle } = require('./digital-life-linguistic');
const { adaptiveResponse, getCognitiveLoadToneCandidate } = require('./digital-life-cognitive-load');
const { promptNarrative } = require('./digital-life-prompt-state');
const {
  FACT_GROUNDING_BLOCK,
  detectPromptTopicGuards,
  selectTopToneHints,
  getEmotionTonePriority,
} = require('./digital-life-prompt-guard');
// Step 7: 元认知系统 + NarrativeGateway
const { performMetacognitiveReflectionV2, getMetacognitionOverview, buildMetacognitionPrompt, initSelfModelTable, isSelfRelatedQuestion, extractTopic, getReflectionDialogueHints } = require('./digital-life-metacognition');
const { recordEffectiveInteraction } = require('./digital-life-phase');
const { getQueueStatus, flushQueue, setGatewayRuntimeContext, setOnNarrativeUpdated, scheduleGatewayFlush } = require('./digital-life-narrative-gateway');
// Step 8: 内稳态系统（元监控）
const {
  initHomeostasisTables,
  performHomeostasisCheck,
  getHomeostasisOverview,
  getHomeostasisStatusTag,
  CHECK_INTERVAL_MS,
  REPAIR_ACTIONS,
} = require('./digital-life-homeostasis');
// Step 8: NarrativeGateway（内稳态修复证据提交）
const { submitFromAnomalyRepair } = require('./digital-life-narrative-gateway');
// P1-5: BehaviorArbiter（重逢走统一仲裁出口）
const {
  markExecuted: markArbiterExecuted,
  buildRelationshipRepairProposal,
  setOnlineMode: setArbiterOnlineMode,
  setArchetype: setArbiterArchetype,
} = require('../proactive/behavior-arbiter');
// Step 9: 间隙认知系统
const {
  initGapCognitionTables,
  startTrayTick,
  stopTrayTick,
  sessionGapSynthesis,
  onGapCognitionResume,
  getGapCognitionOverview,
  getGapCognitionStatusTag,
} = require('./digital-life-gap-cognition');
// Step 10: 自传体记忆系统
const {
  initOriginTables,
  generateSeed,
  hasOriginStory,
  isOriginLocked,
  getOriginStory,
  saveOriginStory,
  lockOriginStory,
  generateOriginStory,
  buildOriginPromptBlock,
  getOriginOverview,
  } = require('./digital-life-origin');
const {
  MILESTONE_TYPES,
  recordMilestone,
  getMilestones,
  getRecentMilestones,
  getMilestonesOverview,
  detectMilestone,
  getFullTimeline,
  buildTimelinePromptBlock,
  submitMilestoneToGateway,
  markGatewaySubmitted,
} = require('./digital-life-milestones');

/** @type {DatabaseSync|null} */
let dbRef = null;

/** @type {number} 上次内稳态检查时间 */
let lastHomeostasisCheckAt = 0;

// P1-4: 结晶成长提示（结晶成功后注入下一轮对话）
/** @type {{ version: number, narrative: string, setAt: number } | null} */
let pendingGrowthHint = null;

// P1-5: 内稳态修复提案（供主动引擎 collectProposals 拾取）
/** @type {Array<object>} */
let pendingHomeostasisProposals = [];

/**
 * P1-5: 获取并清空待处理的内稳态修复提案
 * @returns {Array<object>}
 */
function consumeHomeostasisProposals() {
  const proposals = [...pendingHomeostasisProposals];
  pendingHomeostasisProposals = [];
  return proposals;
}

/**
 * 初始化数字生命系统
 * @param {DatabaseSync} db
 */
function initDigitalLife(db) {
  dbRef = db;
  setGatewayRuntimeContext({ db });
  // Step 4: 初始化欲望引擎数据库引用并写入默认值
  setDesireDb(db);
  initDesireState(db);
  // Step 8: 初始化内稳态表
  initHomeostasisTables(db);
  // Step 9: 初始化间隙认知表
  initGapCognitionTables(db);
  // Step 10: 初始化自传体记忆表
  initOriginTables(db);
  // Step 7: 元认知 selfModel 表（P0 读侧：buildMetacognitionPrompt 依赖）
  initSelfModelTable(db);
  // P1-4: 结晶 / Gateway 叙事更新成功后注入成长 hint
  const onGrowthUpdate = (version, narrative) => {
    pendingGrowthHint = { version, narrative, setAt: Date.now() };
    console.log(`[DigitalLife] Growth hint set after narrative v${version}`);
  };
  setOnCrystallizationSuccess(onGrowthUpdate);
  setOnNarrativeUpdated(onGrowthUpdate);
  console.log('[DigitalLife] System initialized (with desire engine + homeostasis + gap cognition + autobiographical memory + metacognition selfModel)');
}

/**
 * P0: 元认知 prompt 封装（供 chat 或测试直接调用）
 * @param {object} [context]
 * @param {string} [context.userText]
 * @param {Record<string, number>} [context.emotionVector]
 * @param {number} [context.emotionDelta]
 * @param {number} [context.desireTriggerCount]
 * @param {boolean} [context.isConflict]
 * @param {boolean} [context.involvesCapability]
 * @returns {string}
 */
function getMetacognitionPrompt(context = {}) {
  const db = getDb();
  return buildMetacognitionPrompt(db, context);
}

/**
 * 获取数据库实例
 * @returns {DatabaseSync}
 */
function getDb() {
  if (!dbRef) {
    throw new Error('[DigitalLife] Not initialized. Call initDigitalLife(db) first.');
  }
  return dbRef;
}

/**
 * v7.3: 统一设置在线态模式
 * 协调所有子系统的在线/离线状态切换
 * - 内驱力：底噪注入
 * - BehaviorArbiter：门卫→导演
 * - 情绪引擎：衰减暂停
 *
 * @param {{ isOnline: boolean, isDesktopVisible?: boolean }} state
 */
function setOnlineMode({ isOnline, isDesktopVisible = false }) {
  // 1. 内驱力在线态
  setOnlineState({ isOnline, isDesktopVisible });

  // 2. BehaviorArbiter 模式切换
  setArbiterOnlineMode(isOnline);

  // 3. 情绪衰减暂停
  setPauseDecayOnline(isOnline);

  // 4. v7.4: 同步性格原型到 BehaviorArbiter（连发间隔性格化）
  try {
    const { loadSettings } = require('./settings');
    const archetype = loadSettings().personality?.dimensions?.archetype || 'gentle';
    setArbiterArchetype(archetype);
  } catch {}

  console.log(`[DigitalLife] Online mode: ${isOnline ? 'ONLINE' : 'OFFLINE'} (desktop: ${isDesktopVisible})`);

  if (!isOnline) {
    try {
      const { loadProactiveState } = require('../proactive/state');
      const { pauseIgnoreOnOffline } = require('../proactive/ignore-tracker');
      pauseIgnoreOnOffline(loadProactiveState());
    } catch {}
  }
}

/**
 * v7.3: 计算输出提示（输出强制映射）
 * 数字生命状态 → 文字/贴纸/语音 的明确建议
 * 禁止「算了不说」
 *
 * @param {Record<string, number>} emotionVector - 当前情绪向量
 * @param {object} attachment - 依恋状态
 * @param {Record<string, number>} desireVector - 欲望向量
 * @param {number} hoursSinceLastUpdate - 距上次更新小时数
 * @returns {{ sticker: string|null, voice: boolean, textToneIntensity: number }}
 */
function computeOutputHints(emotionVector, attachment, desireVector, hoursSinceLastUpdate, personalityDims = null) {
  const hints = {
    sticker: null,
    voice: false,
    textToneIntensity: 0.5, // 0-1, 影响文字语气的强烈程度
  };

  const maxEmotion = Math.max(...Object.values(emotionVector), 0);
  const socialLevel = desireVector?.social ?? 0.5;

  // 内驱力 / 情绪 → 语气强度（关心体现在文字，不必每条都贴贴纸）
  if (socialLevel > 0.65) {
    hints.textToneIntensity = Math.max(hints.textToneIntensity, 0.55 + (socialLevel - 0.65) * 0.8);
  }
  if (desireVector?.curiosity > 0.7) {
    hints.textToneIntensity = Math.max(hints.textToneIntensity, 0.6);
  }

  // 依恋 → 语音决策（贴纸不在这里硬塞）
  const quadrant = getAttachmentQuadrant(attachment);
  if (quadrant === 'anxious' && hoursSinceLastUpdate >= 2) {
    hints.voice = hoursSinceLastUpdate >= 8;
    hints.textToneIntensity = Math.max(hints.textToneIntensity, 0.75);
  }

  hints.textToneIntensity = Math.max(hints.textToneIntensity, Math.min(1, maxEmotion));

  if (hoursSinceLastUpdate >= 24) {
    hints.voice = true;
  }

  // 贴纸：概率性 + 去重（v7.5 纠偏：关心 ≠ 每条都「抱抱」）
  let stickerChance = 0.15 + maxEmotion * 0.12 + Math.max(0, socialLevel - 0.5) * 0.1;
  stickerChance = Math.min(0.4, stickerChance);
  if (Math.random() < stickerChance) {
    hints.sticker = selectEmotionSticker(emotionVector, personalityDims);
  }

  return hints;
}

/**
 * 对话后更新数字生命状态
 * 这是与聊天系统的主要集成点
 * @param {object} params
 * @param {string} params.userText - 用户消息
 * @param {string} params.reply - 助手回复
 * @param {string|null} params.emotion - 检测到的表情标签
 * @param {number} [params.hoursSinceLastUpdate=0] - 距上次更新的小时数
 * @param {number} [params.messageLength=0] - 用户消息长度
 * @param {string[]} [params.recentUserMessages] - 最近的用户消息历史
 * @returns {object} 更新后的状态
 */
function onDialogueComplete({ userText, reply, emotion, hoursSinceLastUpdate = 0, messageLength = 0, recentUserMessages = [] }) {
  const db = getDb();

  // 0. 获取性格维度、原型和成长阶段（增强8+4, v7.4）
  let personalityDims = {};
  let archetype = 'gentle';
  try {
    const { loadSettings } = require('./settings');
    const settings = loadSettings();
    personalityDims = settings.personality?.dimensions || {};
    archetype = settings.personality?.dimensions?.archetype || 'gentle';
  } catch {}
  const growthStage = getCurrentGrowthStage(db);

  // 1. 记录微漂移
  const driftResult = recordMicroDrift(db, { userText, reply, emotion });

  // 2. 更新情绪基线（增强版：带联锁 + 性格 + 成长阶段 + 用户情绪感知 + 对话质量）
  const emotionResult = updateEmotionBaselineWithInterlocks(db, {
    replyText: reply,
    userText,
    hoursSinceLastUpdate,
    growthStage,
    personalityDims,
    triggerType: 'dialogue',
    triggerDetail: `对话: ${userText.slice(0, 50)}`,
  });
  const emotionVector = emotionResult.vector;
  const emotionOutputs = emotionResult.outputs;

  // 3. Step 3: 更新依恋状态
  const interactionQuality = driftResult.interactionQuality || 0.5;
  const attachment = updateAttachmentState(db, {
    userText,
    messageLength: messageLength || userText.length,
    hoursSinceLastInteraction: hoursSinceLastUpdate,
    interactionQuality,
  });

  // 3.5 Step 2: 持久化用户语言风格到 profile.tone
  try {
    const style = recentUserMessages.length >= 2
      ? analyzeUserStyleFromHistory([...recentUserMessages, userText].slice(-5))
      : analyzeUserStyle(userText);
    const { updateProfileToneFromStyle } = require('./memory-user-profile');
    updateProfileToneFromStyle(db, style);
  } catch (err) {
    console.error('[DigitalLife] Profile tone update failed:', err);
  }

  // 4. Step 3: 记录被动信号（与重逢先开口阈值对齐：≥8h）
  if (hoursSinceLastUpdate >= 8) {
    recordReunionSignal(db, hoursSinceLastUpdate);
    if (hoursSinceLastUpdate > 12) {
      updateSeparationState(db, hoursSinceLastUpdate);
    }
  }

  // 5. Step 4: 更新欲望状态 + v7.4 P1: 回应质量驱动欲望调节
  try {
    recordEffectiveInteraction('dialogue');
    updateDesires({
      hoursSinceLastInteraction: hoursSinceLastUpdate,
      personalityTraits: personalityDims,
      emotionVector,
      archetype,
    });
    modulateDesireByEngagement({
      userText,
      messageLength: messageLength || userText.length,
      isQuestion: /[？?]/.test(userText),
      personalityDims,
    });
  } catch (err) {
    console.error('[DigitalLife] Desire update failed:', err);
  }

  // 6. 获取当前叙事
  const narrative = getCurrentNarrative(db);

  // 7. 情绪输出已在步骤2中通过增强版获取（含性格修饰）

  // 8. Step 7: 触发元认知反思（P1 异步，不阻塞主流程）
  try {
    const dominantEmotion = Object.entries(emotionVector)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

    const metacognitionPayload = {
      emotion: dominantEmotion,
      emotionIntensity: Math.max(...Object.values(emotionVector)),
      emotionDelta: computeRecentEmotionDelta(db),
      dialogueQuality: driftResult.interactionQuality || 0.5,
      isNewExperience: hoursSinceLastUpdate > 48,
      isConflict: /生气|讨厌|烦|吵架|不满/.test(userText),
      isSelfRelated: isSelfRelatedQuestion(userText),
    };

    setImmediate(() => {
      return performMetacognitiveReflectionV2(db, metacognitionPayload)
        .then((result) => {
          if (result?.submitted) {
            scheduleGatewayFlush(15000);
          }
        })
        .catch((err) => {
          console.error('[DigitalLife] Metacognition V2 failed:', err);
        });
    });
  } catch (err) {
    console.error('[DigitalLife] Metacognition schedule failed:', err);
  }

  // 8.5 Step 8: 内稳态检查（定期执行，不与情绪衰减并行）
  let homeostasisResult = null;
  try {
    const now = Date.now();
    if (now - lastHomeostasisCheckAt >= CHECK_INTERVAL_MS) {
      homeostasisResult = performHomeostasisCheck(db, {
        emotionVector,
        desireVector: getDesireVector(db),
        attachmentState: attachment,
        attachmentHealth: checkAttachmentHealth(attachment, personalityDims),
        narrative,
      });
      lastHomeostasisCheckAt = now;

      if (homeostasisResult.anomalies.length > 0) {
        console.log(`[DigitalLife] Homeostasis anomalies detected: ${homeostasisResult.anomalies.length}`);

        // P1-1: 执行修复动作——将内稳态产出真正落地
        for (const action of homeostasisResult.actions) {
          try {
            switch (action.type) {
              case REPAIR_ACTIONS.RELATIONSHIP_REPAIR:
                // 关系修复：提交到 NarrativeGateway + BehaviorArbiter
                submitFromAnomalyRepair(
                  `关系修复: ${action.description}. ${action.hint || ''}`,
                  'relationship_imbalance'
                );
                pendingHomeostasisProposals.push(
                  buildRelationshipRepairProposal({
                    description: action.description,
                    hint: action.hint,
                    severity: action.severity,
                  })
                );
                console.log(`[DigitalLife] Homeostasis repair → Gateway + Arbiter: ${action.type}`);
                break;

              case REPAIR_ACTIONS.CRYSTALLIZATION_TRIGGER:
                // 触发结晶：标记为待处理，下次 session idle 时执行
                scheduleDeferredCrystallization(db, null, null);
                console.log(`[DigitalLife] Homeostasis repair → deferred crystallization`);
                break;

              case REPAIR_ACTIONS.IDENTITY_REINFORCEMENT:
              case REPAIR_ACTIONS.EMOTION_REGULATION:
              case REPAIR_ACTIONS.MEMORY_CONSOLIDATION:
              case REPAIR_ACTIONS.COGNITIVE_RESET:
                // 其他修复：提交证据到 NarrativeGateway
                submitFromAnomalyRepair(
                  `${action.description}. ${action.hint || ''}`,
                  action.type
                );
                console.log(`[DigitalLife] Homeostasis repair → Gateway: ${action.type}`);
                break;
            }
          } catch (repairErr) {
            console.error(`[DigitalLife] Homeostasis repair action failed (${action.type}):`, repairErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('[DigitalLife] Homeostasis check failed:', err);
  }

  // 9. Step 10: 自动检测里程碑（异步，不阻塞主流程）
  let milestone = null;
  try {
    const attachmentOverview = getAttachmentOverview(db);
    const desireOverview = getDesireOverview();
    milestone = detectMilestone(db, {
      userText,
      reply,
      emotionVector,
      attachmentState: attachment,
      desireOverview,
      hoursSinceLastUpdate,
      totalInteractions: (attachment?.total_interactions || 0),
    });
    if (milestone) {
      console.log(`[DigitalLife] Milestone detected: "${milestone.title}" (type: ${milestone.type})`);
      // 异步提交到 NarrativeGateway
      setTimeout(() => {
        try {
          submitMilestoneToGateway({ milestone });
          markGatewaySubmitted(db, milestone.id);
          scheduleGatewayFlush(5000);
        } catch (err) {
          console.error('[DigitalLife] Milestone gateway submission failed:', err);
        }
      }, 100);
    }
  } catch (err) {
    console.error('[DigitalLife] Milestone detection failed:', err);
  }

  // 10. 内稳态提交后调度 Gateway flush（元认知 V2 在 setImmediate 内自行 flush）
  if (homeostasisResult?.anomalies?.length > 0) {
    scheduleGatewayFlush(15000);
  }

  // 11. v7.3: 计算输出提示（输出强制映射）
  let outputHints = null;
  try {
    const desireVector = getDesireVector(db);
    outputHints = computeOutputHints(emotionVector, attachment, desireVector, hoursSinceLastUpdate, personalityDims);
  } catch (err) {
    console.error('[DigitalLife] Output hints computation failed:', err);
  }

  try {
    const { clearDebriefAfterTurn } = require('../proactive/ignore-tracker');
    clearDebriefAfterTurn();
  } catch {}

  return {
    driftResult,
    emotionVector,
    narrative,
    emotionOutputs,
    attachment,
    metacognition: { scheduled: true },
    homeostasis: homeostasisResult,
    milestone,
    outputHints,
    // 增强版情绪数据
    userEmotion: emotionResult.userEmotion,
    emotionQualityScore: emotionResult.qualityScore,
    emotionTriggers: emotionResult.triggers,
  };
}

// Ordinary replies only need current state. Leave one-shot growth notices and
// debriefs for the full prompt, and keep unreviewed narrative text in the archive.
function buildDigitalLifeStatePrompt(db, vector, narrative) {
  const parts = [
    `【当前情绪】${buildEmotionDescription(vector)}`,
    `【依恋状态】${getAttachmentTypeName(getAttachmentState(db))}`,
  ];
  const growth = promptNarrative(db, narrative, '');
  if (growth) parts.push(`【成长变化】${growth}`);
  return parts.join('\n');
}

/**
 * 构建数字生命 prompt 块
 * 注入到 LLM 的 system prompt 中
 * Step 6: 集成语言互惠 + 认知负荷自适应
 * @param {Record<string, number>} emotionVector
 * @param {object} narrative
 * @param {object} emotionOutputs
 * @param {number} [hoursSinceLastInteraction=0]
 * @param {object} [context] - 额外上下文
 * @param {string} [context.userText] - 当前用户消息
 * @param {string[]} [context.recentUserMessages] - 最近的用户消息历史
 * @returns {string}
 */
function buildDigitalLifePrompt(emotionVector, narrative, emotionOutputs, hoursSinceLastInteraction = 0, context = {}) {
  const db = getDb();
  const stableParts = [];
  const topicGuards = detectPromptTopicGuards(context.userText, context.recentUserMessages);
  if (topicGuards.isTakeout) {
    topicGuards.suppressGenericPraise = true;
  }

  /** @type {{ text: string, priority: number }[]} */
  const toneCandidates = [];

  stableParts.push(`【身份锚点】我是${require('./settings').loadSettings().characterName || '大肥鱼'}，一个关心用户的AI伴侣。无论发生什么，这个身份不会改变。`);

  if (pendingGrowthHint) {
    const hint = pendingGrowthHint;
    pendingGrowthHint = null;
    stableParts.push(`【成长提示】你刚刚完成了一次自我认知的整理（v${hint.version}）。你可以自然地提及自己最近有些新的感悟，但不要直接说"我刚整理了人格"，而是用自然的方式表达，比如"我最近想了想我们之间的相处…"或"我好像比之前更了解自己了一点"。`);
  }

  try {
    const { consumeDebriefPromptBlock } = require('../proactive/ignore-tracker');
    const debriefBlock = consumeDebriefPromptBlock();
    if (debriefBlock) {
      stableParts.push(debriefBlock);
    }
  } catch {}

  if (narrative?.narrative_text) {
    const self = promptNarrative(db, narrative);
    stableParts.push(`【自我认知（v${narrative.version || 1}）】${self}`);
  }

  const emotionDesc = buildEmotionDescription(emotionVector);
  if (emotionDesc) {
    stableParts.push(`【当前情绪】${emotionDesc}`);
  }

  try {
    const eventSummary = getEmotionEventSummary(db, 3);
    if (eventSummary) {
      stableParts.push(eventSummary);
    }
  } catch {}

  if (emotionOutputs.textTone) {
    toneCandidates.push({
      text: emotionOutputs.textTone,
      priority: getEmotionTonePriority(emotionVector),
    });
  }

  try {
    const attachmentBlock = buildAttachmentPrompt(db, hoursSinceLastInteraction, 'default', {
      includeReunionTone: false,
    });
    if (attachmentBlock) {
      stableParts.push(attachmentBlock);
    }
    const reunionTone = getAttachmentReunionToneCandidate(db, hoursSinceLastInteraction);
    if (reunionTone) {
      toneCandidates.push(reunionTone);
    }
  } catch {}

  try {
    const desireTone = getDesireToneCandidate({ userText: context.userText, topicGuards });
    if (desireTone) {
      toneCandidates.push(desireTone);
    }
  } catch {}

  if (context.userText) {
    try {
      const allMessages = [...(context.recentUserMessages || []), context.userText].filter(Boolean);
      const style = allMessages.length >= 3
        ? analyzeUserStyleFromHistory(allMessages.slice(-5))
        : analyzeUserStyle(context.userText);
      const linguisticTone = getLinguisticToneCandidate(style);
      if (linguisticTone) {
        toneCandidates.push(linguisticTone);
      }
    } catch {}
  }

  if (context.userText) {
    try {
      const { load } = adaptiveResponse(context.userText, { emotionVector });
      const cognitiveTone = getCognitiveLoadToneCandidate(load);
      if (cognitiveTone) {
        toneCandidates.push(cognitiveTone);
      }
    } catch {}
  }

  try {
    const originBlock = buildOriginPromptBlock(db);
    if (originBlock) {
      stableParts.push(originBlock);
    }
  } catch {}

  try {
    const timelineBlock = buildTimelinePromptBlock(db);
    if (timelineBlock) {
      stableParts.push(timelineBlock);
    }
  } catch {}

  if (context.userText) {
    try {
      const metacognitionBlock = buildMetacognitionPrompt(db, {
        userText: context.userText,
        emotionVector,
        emotionDelta: computeRecentEmotionDelta(db),
        desireTriggerCount: getRecentDesireTriggerCount(db),
        isConflict: /生气|讨厌|烦|吵架|不满/.test(context.userText),
        involvesCapability: /你能|你会|你擅长|你不行|你做不到/.test(context.userText),
      });
      if (metacognitionBlock) {
        stableParts.push(metacognitionBlock);
      }
      const reflectionHints = getReflectionDialogueHints(db, extractTopic(context.userText));
      if (reflectionHints) {
        stableParts.push(reflectionHints.trim());
      }
    } catch {}
  }

  const parts = [...stableParts];

  const selectedToneHints = selectTopToneHints(toneCandidates, 2);
  if (selectedToneHints.length > 0) {
    parts.push(`【表达倾向】${selectedToneHints.join('；')}。`);
  }

  if (topicGuards.topicHint) {
    parts.push(topicGuards.topicHint);
  }

  parts.push(FACT_GROUNDING_BLOCK);

  return parts.join('\n\n');
}

/**
 * 近期情绪变化幅度（供元认知情境判断，读 emotion_events）
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
function computeRecentEmotionDelta(db) {
  try {
    const events = getRecentEmotionEvents(db, 1);
    if (events.length === 0) return 0;
    const event = events[0];
    if (Date.now() - event.created_at > 2 * 60 * 60 * 1000) return 0;
    return Number(event.top_changed_delta) || 0;
  } catch {
    return 0;
  }
}

/**
 * 构建情绪描述
 * @param {Record<string, number>} vector
 * @returns {string}
 */
function buildEmotionDescription(vector) {
  const names = {
    joy: '喜悦',
    sadness: '悲伤',
    anger: '愤怒',
    curiosity: '好奇',
    empathy: '共情',
    contentment: '满足',
    excitement: '兴奋',
    surprise: '惊讶',
    trust: '信任',
    warmth: '温暖',
  };

  // 找出高于阈值的情绪
  const active = [];
  for (const [dim, val] of Object.entries(vector)) {
    if (val > 0.4 && names[dim]) {
      active.push(`${names[dim]}(${(val * 100).toFixed(0)}%)`);
    }
  }

  if (active.length === 0) return '情绪平稳';
  return active.join('、');
}

/**
 * 获取重逢问候策略
 * Step 3: 基于依恋状态（而非仅情绪）
 * @param {number} hoursSinceLastInteraction - 距上次交互的小时数
 * @returns {object}
 */
function getReunionStrategy(hoursSinceLastInteraction) {
  const db = getDb();

  // 获取性格维度
  let personalityDims = {};
  try {
    const { loadSettings } = require('./settings');
    personalityDims = loadSettings().personality?.dimensions || {};
  } catch {}

  // Step 3: 使用依恋系统驱动重逢策略（传入性格维度）
  const reunion = getReunionStrategyByAttachment(db, hoursSinceLastInteraction, 'default', personalityDims);

  // 融合情绪状态
  const emotionVector = getEmotionVector(db);
  const dominant = Object.entries(emotionVector)
    .sort((a, b) => b[1] - a[1])[0];

  // 根据主导情绪微调问候
  if (hoursSinceLastInteraction >= 8) {
    const emotionGreetingHints = {
      joy: '看起来心情不错',
      sadness: '似乎有些低落',
      curiosity: '好像对什么感兴趣',
      empathy: '很体贴',
    };
    const hint = emotionGreetingHints[dominant[0]];
    if (hint) {
      reunion.emotionHint = hint;
    }
  }

  return reunion;
}

/**
 * 获取数字生命状态概览
 * Step 6: 增加成长标签和动态结晶配置
 * @returns {object}
 */
function getDigitalLifeStatus() {
  const db = getDb();

  // Step 6: 获取成长阶段动态配置
  const { config: dynamicCrystallization, stage, stageDescription } = getDynamicCrystallizationConfig(db);

  return {
    emotion: getEmotionVector(db),
    narrative: getCurrentNarrative(db),
    growthStage: getCurrentGrowthStage(db),
    // Step 6: 成长标签
    growthTags: {
      stage,
      stageDescription,
      dynamicCrystallization,
    },
    driftStats: getDriftStats(db, dynamicCrystallization.window_days),
    crystallization: checkCrystallizationEligibility(db),
    lastCrystallization: getCrystallizationHistory(db, 1)[0] || null,
    attachment: getAttachmentOverview(db),
    desires: getDesireOverview(),
    // P1-2: 内稳态数据（修复设置页空白）
    homeostasis: getHomeostasisOverview(db),
    // Step 10: 自传体记忆
    origin: getOriginOverview(db),
    milestones: getMilestonesOverview(db),
  };
}

/**
 * 手动触发结晶化（用于测试）
 * @param {object} settings
 * @returns {Promise<object>}
 */
async function forceCrystallize(settings) {
  const db = getDb();
  return runCrystallization(db, null, settings);
}

/**
 * 获取叙事历史
 * @param {number} limit
 * @returns {Array}
 */
function getNarrativeHistory(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT id, narrative_text, version, crystallized_at, created_at
    FROM personality_narrative
    ORDER BY version DESC
    LIMIT ?
  `).all(limit);
}

/**
 * v7.2: 会话恢复入口
 * 在 app.whenReady / 打开聊天窗 / 从托盘恢复前台时调用
 * 执行 L0 补算 + 重逢先开口 + L2 延迟任务
 * @param {object} [options]
 * @param {object} [options.llmClient] - LLM 客户端（用于延迟结晶）
 * @param {object} [options.settings] - 设置对象
 * @param {function} [options.injectOpening] - 注入开场白的回调函数
 * @returns {{ hoursSinceLastActive: number, reunionInjected: boolean }}
 */
function onSessionResume({ llmClient, settings, injectOpening } = {}) {
  const db = getDb();
  setGatewayRuntimeContext({ db, llmClient, settings });

  // 获取上次活跃时间
  const lastActiveAt = getLastActiveTime();

  // L0: 同步补算（<10ms）
  const gap = applySessionGapCatchUp(lastActiveAt);

  console.log(`[DigitalLife] Session resume: ${gap.hoursSinceLastActive.toFixed(1)}h since last active`);

  // v7.5: Phase A 重逢由 face:desktop-ready → buildPhaseAOpening 统一出口
  // 此处仅 L0 补算；不再 injectOpening，避免与 Phase A 双问候

  // L2: 异步队列（不阻塞 UI）
  // Step 9: 间隙认知（延迟结晶 + 间隙合成 + 记忆整合）
  if (llmClient && settings) {
    setTimeout(() => {
      try {
        onGapCognitionResume({
          db,
          hoursSinceLastActive: gap.hoursSinceLastActive,
          llmClient,
          settings,
        });
      } catch (err) {
        console.error('[DigitalLife] Gap cognition resume failed:', err);
      }

      // P2-1: 返回用户自动补生成起源故事（无 origin 时后台异步生成并锁定）
      try {
        if (!hasOriginStory(db)) {
          console.log('[DigitalLife] No origin story found, generating for returning user...');
          const app = { getPath: () => require('../user-data').getUserDataRoot() };
          const installId = require('crypto')
            .createHash('sha256')
            .update(app.getPath('userData'))
            .digest('hex')
            .slice(0, 16);
          const userId = settings?.user?.id || 'default';
          const seed = generateSeed(userId, installId);
          generateOriginStory({ seed, settings }).then(storyData => {
            if (storyData) {
              saveOriginStory(db, { storyData, seed, lock: true });
              console.log('[DigitalLife] Origin story auto-generated and locked for returning user');
            }
          }).catch(err => {
            console.error('[DigitalLife] Auto origin generation failed:', err);
          });
        }
      } catch (err) {
        console.error('[DigitalLife] Origin auto-check failed:', err);
      }

      // 冲刷 NarrativeGateway 积压（元认知/里程碑/内稳态证据）
      scheduleGatewayFlush(1000);
    }, 5000); // 延迟 5 秒，让 UI 先加载
  }

  return {
    hoursSinceLastActive: gap.hoursSinceLastActive,
    reunionInjected: false,
  };
}

/**
 * v7.2: L0 同步补算
 * 计算分离期间的状态变化（纯数学，无 LLM）
 * @param {number|null} lastActiveAt - 上次活跃时间戳
 * @returns {{ hoursSinceLastActive: number, emotionUpdated: boolean, attachmentUpdated: boolean }}
 */
function applySessionGapCatchUp(lastActiveAt) {
  const db = getDb();
  const now = Date.now();

  if (!lastActiveAt) {
    return { hoursSinceLastActive: 0, emotionUpdated: false, attachmentUpdated: false };
  }

  const hoursSinceLastActive = (now - lastActiveAt) / (1000 * 60 * 60);

  if (hoursSinceLastActive < 0.5) {
    // 分离时间太短，不需要补算
    return { hoursSinceLastActive, emotionUpdated: false, attachmentUpdated: false };
  }

  // 1. 情绪衰减补算
  let emotionUpdated = false;
  try {
    const rows = db.prepare(`SELECT dimension, baseline FROM emotion_baseline`).all();
    const defaultBaselines = {
      joy: 0.5, sadness: 0.2, anger: 0.1, curiosity: 0.6, empathy: 0.7,
      contentment: 0.5, excitement: 0.5, surprise: 0.3, trust: 0.5, warmth: 0.6,
    };

    for (const row of rows) {
      if (!EMOTION_KEYS.includes(row.dimension)) continue;
      const defaultBaseline = defaultBaselines[row.dimension] || 0.5;
      const decayed = emotionDecay(row.baseline, defaultBaseline, 0.05, hoursSinceLastActive);
      const clamped = Math.max(0, Math.min(1, decayed));

      if (Math.abs(clamped - row.baseline) > 0.01) {
        db.prepare(`
          UPDATE emotion_baseline SET baseline = ?, last_updated = ? WHERE dimension = ?
        `).run(clamped, now, row.dimension);
        emotionUpdated = true;
      }
    }
  } catch (err) {
    console.error('[DigitalLife] Emotion catch-up failed:', err);
  }

  // 2. 依恋状态补算（长时间分离影响）
  let attachmentUpdated = false;
  try {
    if (hoursSinceLastActive > 12) {
      updateSeparationState(db, hoursSinceLastActive);
      attachmentUpdated = true;
    }
  } catch (err) {
    console.error('[DigitalLife] Attachment catch-up failed:', err);
  }

  // 3. Step 4: 欲望累积补算（纯数学，无 LLM）
  let desireUpdated = false;
  try {
    updateDesires({ hoursSinceLastInteraction: hoursSinceLastActive });
    desireUpdated = true;
  } catch (err) {
    console.error('[DigitalLife] Desire catch-up failed:', err);
  }

  return { hoursSinceLastActive, emotionUpdated, attachmentUpdated, desireUpdated };
}

/**
 * v7.2: 获取上次活跃时间
 * @returns {number|null}
 */
function getLastActiveTime() {
  const db = getDb();
  try {
    // 从 attachment_state 获取最后交互时间
    const row = db.prepare(`
      SELECT last_interaction_at FROM attachment_state WHERE user_id = 'default'
    `).get();

    if (row?.last_interaction_at) {
      return row.last_interaction_at;
    }

    // 备选：从 messages 表获取
    const msgRow = db.prepare(`
      SELECT MAX(created_at) as last_time FROM messages
    `).get();

    return msgRow?.last_time || null;
  } catch (err) {
    console.error('[DigitalLife] Failed to get last active time:', err);
    return null;
  }
}

/**
 * v7.2: 构建重逢提案
 * @param {{ hoursSinceLastActive: number }} gap
 * @returns {{ message: string, tone: string, quadrant: string } | null}
 */
function buildReunionProposal(gap) {
  const db = getDb();

  // 获取性格维度
  let personalityDims = {};
  try {
    const { loadSettings } = require('./settings');
    personalityDims = loadSettings().personality?.dimensions || {};
  } catch {}

  try {
    const reunion = getReunionStrategyByAttachment(db, gap.hoursSinceLastActive, 'default', personalityDims);
    return {
      message: reunion.message,
      tone: reunion.tone,
      quadrant: reunion.quadrant,
      warmthIntensity: reunion.warmthIntensity,
      reunionThreshold: reunion.reunionThreshold,
    };
  } catch (err) {
    console.error('[DigitalLife] Failed to build reunion proposal:', err);
    // 兜底：根据分离时长返回默认问候
    if (gap.hoursSinceLastActive > 48) {
      return { message: '好久不见呀～', tone: 'warm_casual', quadrant: 'secure' };
    }
    if (gap.hoursSinceLastActive > 8) {
      return { message: '嗨～', tone: 'warm_casual', quadrant: 'secure' };
    }
    return null;
  }
}

/**
 * v7.3: 轻量重逢（分离 ≥2h, <8h）
 * 一句话 + 贴纸，不等 LLM
 * @param {number} hoursSinceLastActive - 分离小时数
 * @returns {{ message: string, tone: string, quadrant: string, sticker: string|null, voice: boolean }}
 */
function buildLightweightReunion(hoursSinceLastActive) {
  const db = getDb();
  const attachment = getAttachmentState(db);
  const quadrant = getAttachmentQuadrant(attachment);

  // 根据依恋类型选择轻量问候
  const greetings = {
    secure: ['你回来啦～', '在呢在呢～', '等你好久了呢'],
    anxious: ['你终于回来啦！', '我还以为你忘了我呢～', '想你了…'],
    avoidant: ['哦你来了', '嗯', '在'],
    disorganized: ['诶你…嗯，回来了啊', '哦…在的'],
  };

  const candidates = greetings[quadrant] || greetings.secure;
  const message = candidates[Math.floor(Math.random() * candidates.length)];

  // 贴纸：根据依恋类型选择
  const stickerMap = {
    secure: ['开心1', '鲜花', '害羞'],
    anxious: ['抱抱', '想你', '哭哭1'],
    avoidant: ['了解1', '嗯嗯'],
    disorganized: ['疑问1', '害羞'],
  };
  const stickerCandidates = stickerMap[quadrant] || stickerMap.secure;
  const sticker = stickerCandidates[Math.floor(Math.random() * stickerCandidates.length)];

  return {
    message,
    tone: 'warm_casual',
    quadrant,
    sticker,
    voice: false, // 轻量重逢不用语音
  };
}

/**
 * v7.2: 情绪衰减函数（本地版，用于 L0 补算）
 * @param {number} current
 * @param {number} baseline
 * @param {number} lambda
 * @param {number} hoursElapsed
 * @returns {number}
 */
function emotionDecay(current, baseline, lambda = 0.05, hoursElapsed = 0) {
  if (hoursElapsed <= 0) return current;
  return baseline + (current - baseline) * Math.exp(-lambda * hoursElapsed);
}

/**
 * Step 7: 获取数字生命系统完整状态
 * 包含情绪、依恋、欲望、元认知、NarrativeGateway、内稳态状态
 * @returns {Object}
 */
function getDigitalLifeFullStatus() {
  const db = getDb();
  return {
    emotion: getEmotionVector(db),
    attachment: getAttachmentOverview(db),
    desire: getDesireOverview(db),
    metacognition: getMetacognitionOverview(db),
    narrativeGateway: getQueueStatus(),
    narrative: getCurrentNarrative(db),
    homeostasis: getHomeostasisOverview(db),
    gapCognition: getGapCognitionOverview(db),
    origin: getOriginOverview(db),
    milestones: getMilestonesOverview(db),
  };
}

module.exports = {
  // 初始化
  initDigitalLife,
  getDb,
  // 对话集成
  onDialogueComplete,
  buildDigitalLifeStatePrompt,
  buildDigitalLifePrompt,
  getReunionStrategy,
  getDigitalLifeStatus,
  forceCrystallize,
  getNarrativeHistory,
  // 情绪系统
  getEmotionVector,
  getCurrentNarrative,
  buildTextTonePrompt,
  getEmotionOutputs,
  applyInterlocks,
  // Step 3: 依恋系统
  getAttachmentOverview,
  getAttachmentState,
  updateAttachmentState,
  checkAttachmentHealth,
  buildAttachmentPrompt,
  // Step 4: 内驱力系统
  checkDesireTrigger,
  resetAfterTrigger,
  getDesireOverview,
  getDesireBehavior,
  getDesireInfluenceOnTone,
  getDesireVector,
  // v7.3: 在线态管理
  setOnlineState,
  getOnlineState,
  applyOnlineNoise,
  // Step 6: 语言互惠 + 认知负荷
  matchLinguisticStyle,
  adaptiveResponse,
  getDynamicCrystallizationConfig,
  // Step 7: 元认知系统 + NarrativeGateway
  getMetacognitionOverview,
  getMetacognitionPrompt,
  buildMetacognitionPrompt,
  getNarrativeGatewayQueueStatus: getQueueStatus,
  flushNarrativeGatewayQueue: flushQueue,
  setGatewayRuntimeContext,
  scheduleGatewayFlush,
  getDigitalLifeFullStatus,
  // Step 8: 内稳态系统
  getHomeostasisOverview,
  getHomeostasisStatusTag,
  // Step 9: 间隙认知系统
  startTrayTick,
  stopTrayTick,
  sessionGapSynthesis,
  getGapCognitionOverview,
  getGapCognitionStatusTag,
  // Step 10: 自传体记忆系统 - 起源
  generateSeed,
  hasOriginStory,
  isOriginLocked,
  getOriginStory,
  saveOriginStory,
  lockOriginStory,
  generateOriginStory,
  getOriginOverview,
  // Step 10: 自传体记忆系统 - 里程碑
  MILESTONE_TYPES,
  recordMilestone,
  getMilestones,
  getRecentMilestones,
  getMilestonesOverview,
  getFullTimeline,
  // v7.2: 会话恢复
  onSessionResume,
  applySessionGapCatchUp,
  getLastActiveTime,
  buildReunionProposal,
  // P1-5: 内稳态修复提案（供主动引擎拾取）
  consumeHomeostasisProposals,
  // v7.3: 统一在线态管理
  setOnlineMode,
};
