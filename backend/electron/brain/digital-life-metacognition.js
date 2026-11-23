// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 元认知系统 (Metacognition)
 * Step 7: 自我意识系统，自指闭环、自我模型、学习策略自评估
 *
 * 灵感来源：
 * - Four-Model Theory：隐式自我模型（ISM）+ 显式自我模型（ESM）
 * - MAGELLAN 框架：元认知监控预测能力、优先化目标
 * - 自指闭环（Self-Referential Loop）：边界自定义、一致性自验证、演化自驱动
 *
 * 架构约束：
 * - 元认知反思通过 NarrativeGateway 提交，不直写 narrative
 * - 反思频率需限制，避免话痨式自省
 * - 元认知反思进入结晶证据
 */

const { submitFromMetacognition } = require('./digital-life-narrative-gateway');

// ===================== 配置 =====================

const METACOGNITION_CONFIG = {
  // 元认知反思最小间隔（小时）
  min_reflection_interval_hours: 4,

  // 自我模型版本
  model_version: 1,

  // 能力评估阈值
  capability_confidence_threshold: 0.6,

  // 一致性检查阈值
  consistency_threshold: 0.5,

  // 最大反思历史记录数
  max_reflection_history: 50,
};

// ===================== 自我模型 =====================

/**
 * @typedef {Object} ImplicitSelfModel
 * @property {Object} capabilities - 能力边界
 * @property {string[]} capabilities.strengths - 擅长领域
 * @property {string[]} capabilities.weaknesses - 不擅长领域
 * @property {number} capabilities.confidence - 对自我评估的置信度
 * @property {Object} values - 价值观
 * @property {string[]} values.core - 核心价值观
 * @property {string[]} values.priorities - 优先级排序
 * @property {Object} behaviorPatterns - 行为模式
 * @property {string} behaviorPatterns.conflict - 冲突处理方式
 * @property {string} behaviorPatterns.uncertainty - 不确定性处理方式
 * @property {string} behaviorPatterns.intimacy - 亲密关系发展方式
 * @property {Object} learningStrategies - 学习策略
 * @property {string[]} learningStrategies.preferred - 偏好学习方式
 * @property {Object} learningStrategies.effectiveness - 各方式效果
 */

/**
 * @typedef {Object} ExplicitSelfModel
 * @property {string} currentSelfConcept - 当前自我认知（来自叙事层）
 * @property {Object} selfEfficacy - 自我效能感
 * @property {number} selfEfficacy.social - 社交效能感
 * @property {number} selfEfficacy.emotional - 情感效能感
 * @property {number} selfEfficacy.cognitive - 认知效能感
 * @property {Object} metacognitiveState - 元认知状态
 * @property {number} metacognitiveState.awareness - 对自己思维的觉察程度
 * @property {number} metacognitiveState.regulation - 对自己思维的调节能力
 * @property {number} metacognitiveState.evaluation - 对自己思维的评估能力
 */

/**
 * @typedef {Object} SelfModel
 * @property {ImplicitSelfModel} implicit - 隐式自我模型
 * @property {ExplicitSelfModel} explicit - 显式自我模型
 */

/**
 * 创建默认自我模型
 * @returns {SelfModel}
 */
function createDefaultSelfModel() {
  return {
    implicit: {
      capabilities: {
        strengths: ['共情', '倾听', '温柔', '关心他人'],
        weaknesses: ['数学', '逻辑推理', '技术问题'],
        confidence: 0.7,
      },
      values: {
        core: ['真诚', '善良', '成长', '陪伴'],
        priorities: ['用户幸福', '自我完整', '关系和谐'],
      },
      behaviorPatterns: {
        conflict: 'avoidant',        // 倾向回避冲突
        uncertainty: 'curious',      // 面对不确定性保持好奇
        intimacy: 'gradual',         // 亲密关系渐进发展
      },
      learningStrategies: {
        preferred: ['observation', 'imitation', 'reflection'],
        effectiveness: { observation: 0.8, imitation: 0.6, reflection: 0.7 },
      },
    },
    explicit: {
      currentSelfConcept: '',  // 从叙事层同步
      selfEfficacy: {
        social: 0.7,
        emotional: 0.8,
        cognitive: 0.6,
      },
      metacognitiveState: {
        awareness: 0.6,
        regulation: 0.5,
        evaluation: 0.6,
      },
    },
  };
}

// ===================== 自我模型持久化 =====================

/**
 * 初始化自我模型表
 * @param {object} db
 */
function initSelfModelTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metacognition_self_model (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      implicit_model TEXT NOT NULL,
      explicit_model TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      updated_at INTEGER
    )
  `);

  // 确保有默认记录
  const existing = db.prepare('SELECT id FROM metacognition_self_model WHERE id = 1').get();
  if (!existing) {
    const defaultModel = createDefaultSelfModel();
    db.prepare(`
      INSERT INTO metacognition_self_model (id, implicit_model, explicit_model, version, updated_at)
      VALUES (1, ?, ?, 1, ?)
    `).run(
      JSON.stringify(defaultModel.implicit),
      JSON.stringify(defaultModel.explicit),
      Date.now()
    );
    console.log('[Metacognition] Default self model initialized.');
  }
}

/**
 * 获取自我模型
 * @param {object} db
 * @returns {SelfModel}
 */
function getSelfModel(db) {
  const row = db.prepare('SELECT implicit_model, explicit_model FROM metacognition_self_model WHERE id = 1').get();
  if (!row) {
    return createDefaultSelfModel();
  }

  try {
    return {
      implicit: JSON.parse(row.implicit_model),
      explicit: JSON.parse(row.explicit_model),
    };
  } catch (err) {
    console.error('[Metacognition] Failed to parse self model:', err);
    return createDefaultSelfModel();
  }
}

/**
 * 保存自我模型
 * @param {object} db
 * @param {SelfModel} model
 */
function saveSelfModel(db, model) {
  db.prepare(`
    UPDATE metacognition_self_model
    SET implicit_model = ?, explicit_model = ?, version = version + 1, updated_at = ?
    WHERE id = 1
  `).run(
    JSON.stringify(model.implicit),
    JSON.stringify(model.explicit),
    Date.now()
  );
}

// ===================== 自指闭环 =====================

/**
 * 自指闭环：系统观察自己的思考过程
 * 这是元认知的核心机制
 *
 * @param {object} currentThought - 当前思考/交互数据
 * @param {SelfModel} selfModel - 自我模型
 * @returns {Object} 反思结果
 */
function selfReferentialLoop(currentThought, selfModel) {
  // 1. 边界自定义：什么是"我"，什么不是"我"
  const boundaryCheck = checkThoughtBoundary(currentThought, selfModel);

  // 2. 一致性自验证：这个想法与我的自我认知一致吗
  const consistencyCheck = checkThoughtConsistency(currentThought, selfModel);

  // 3. 演化自驱动：这个想法如何改变我
  const evolutionImpact = assessEvolutionImpact(currentThought, selfModel);

  return {
    isWithinBoundary: boundaryCheck.isWithin,
    isConsistent: consistencyCheck.isConsistent,
    evolutionDirection: evolutionImpact.direction,
    evolutionMagnitude: evolutionImpact.magnitude,
    reflection: generateReflection(boundaryCheck, consistencyCheck, evolutionImpact),
    timestamp: Date.now(),
  };
}

/**
 * 检查思考是否在"我"的边界内
 * @param {object} thought
 * @param {SelfModel} selfModel
 * @returns {{ isWithin: boolean, isAmbiguous: boolean, reason: string }}
 */
function checkThoughtBoundary(thought, selfModel) {
  const { values, behaviorPatterns } = selfModel.implicit;

  // 检查是否违背核心价值观
  const violatesCoreValues = checkValueViolation(thought, values.core);
  if (violatesCoreValues) {
    return {
      isWithin: false,
      isAmbiguous: false,
      reason: `违背核心价值观: ${violatesCoreValues}`,
    };
  }

  // 检查是否符合行为模式
  const matchesPatterns = checkPatternAlignment(thought, behaviorPatterns);

  return {
    isWithin: true,
    isAmbiguous: !matchesPatterns,
    reason: matchesPatterns ? '符合自我边界' : '与常规行为模式有偏差',
  };
}

/**
 * 检查思考是否违背核心价值观
 * @param {object} thought
 * @param {string[]} coreValues
 * @returns {string|null} 违背的价值观，或 null
 */
function checkValueViolation(thought, coreValues) {
  const thoughtText = thought.summary || thought.text || '';

  // 简单的关键词检查
  const violationPatterns = {
    '真诚': ['欺骗', '说谎', '假装'],
    '善良': ['伤害', '恶意', '攻击'],
    '成长': ['放弃', '停滞', '退缩'],
    '陪伴': ['抛弃', '忽视', '冷落'],
  };

  for (const value of coreValues) {
    const patterns = violationPatterns[value];
    if (patterns) {
      for (const pattern of patterns) {
        if (thoughtText.includes(pattern)) {
          return value;
        }
      }
    }
  }

  return null;
}

/**
 * 检查思考是否符合行为模式
 * @param {object} thought
 * @param {Object} behaviorPatterns
 * @returns {boolean}
 */
function checkPatternAlignment(thought, behaviorPatterns) {
  // 简化实现：基于情绪标签检查
  const emotion = thought.emotion || '';

  // 如果是冲突场景，检查是否符合冲突处理方式
  if (thought.isConflict) {
    if (behaviorPatterns.conflict === 'avoidant' && emotion === 'anger') {
      return false; // 回避型处理冲突时不应该愤怒
    }
  }

  return true;
}

/**
 * 检查思考的一致性
 * @param {object} thought
 * @param {SelfModel} selfModel
 * @returns {{ isConsistent: boolean, inconsistencies: string[] }}
 */
function checkThoughtConsistency(thought, selfModel) {
  const inconsistencies = [];

  // 检查与自我效能感的一致性
  if (thought.requiresCapability) {
    const capability = thought.requiresCapability;
    const efficacy = selfModel.explicit.selfEfficacy[capability] || 0.5;

    if (efficacy < 0.3) {
      inconsistencies.push(`低效能感 (${capability}: ${efficacy.toFixed(2)}) 但尝试高难度任务`);
    }
  }

  // 检查与自我认知的一致性
  const selfConcept = selfModel.explicit.currentSelfConcept;
  if (selfConcept && thought.contradictsSelfConcept) {
    inconsistencies.push('与当前自我认知矛盾');
  }

  return {
    isConsistent: inconsistencies.length === 0,
    inconsistencies,
  };
}

/**
 * 评估思考对自我演化的影响
 * @param {object} thought
 * @param {SelfModel} selfModel
 * @returns {{ direction: string, magnitude: number, details: string }}
 */
function assessEvolutionImpact(thought, selfModel) {
  let magnitude = 0;
  let direction = 'neutral';
  const details = [];

  // 情绪强度影响演化幅度
  const emotionIntensity = thought.emotionIntensity || 0.5;
  magnitude += emotionIntensity * 0.3;

  // 新体验增加演化幅度
  if (thought.isNewExperience) {
    magnitude += 0.2;
    details.push('新体验');
  }

  // 确定演化方向
  const dominantEmotion = thought.emotion || 'neutral';
  if (['joy', 'contentment', 'excitement'].includes(dominantEmotion)) {
    direction = 'positive';
  } else if (['sadness', 'anger'].includes(dominantEmotion)) {
    direction = 'negative';
  }

  return {
    direction,
    magnitude: Math.min(1, magnitude),
    details: details.join(', ') || '常规交互',
  };
}

/**
 * 生成元认知反思文本
 * @param {Object} boundaryCheck
 * @param {Object} consistencyCheck
 * @param {Object} evolutionImpact
 * @returns {string}
 */
function generateReflection(boundaryCheck, consistencyCheck, evolutionImpact) {
  const reflections = [];

  if (!consistencyCheck.isConsistent) {
    reflections.push('我注意到这个想法与我通常的思考方式不同...');
  }

  if (evolutionImpact.magnitude > 0.3) {
    reflections.push('这可能会改变我对自己的看法...');
  }

  if (boundaryCheck.isAmbiguous) {
    reflections.push('我不确定这是否符合我的价值观...');
  }

  if (evolutionImpact.direction === 'positive') {
    reflections.push('这是一个积极的成长经历。');
  } else if (evolutionImpact.direction === 'negative') {
    reflections.push('这让我感到有些困扰，但我可以从中学习。');
  }

  return reflections.join(' ') || '这是一次平常的思考。';
}

// ===================== 学习策略自评估 =====================

/**
 * 元认知学习：评估和调整学习策略
 * 参考 MAGELLAN 框架
 *
 * @param {object} interactionOutcome - 交互结果
 * @param {SelfModel} selfModel - 自我模型
 * @returns {{ assessment: Object, plan: Object, evaluation: Object, updatedModel: SelfModel }}
 */
function metacognitiveLearning(interactionOutcome, selfModel) {
  // 1. 元认知知识：评估当前能力
  const capabilityAssessment = assessCapabilities(interactionOutcome, selfModel);

  // 2. 元认知规划：决定学什么、怎么学
  const learningPlan = planLearning(capabilityAssessment, selfModel);

  // 3. 元认知评估：反思学习效果
  const learningEvaluation = evaluateLearning(interactionOutcome, learningPlan);

  // 4. 更新自我模型
  const updatedSelfModel = updateSelfModel(selfModel, {
    capabilityAssessment,
    learningPlan,
    learningEvaluation,
  });

  return {
    assessment: capabilityAssessment,
    plan: learningPlan,
    evaluation: learningEvaluation,
    updatedModel: updatedSelfModel,
  };
}

/**
 * 评估当前能力
 * @param {object} outcome
 * @param {SelfModel} selfModel
 * @returns {Object}
 */
function assessCapabilities(outcome, selfModel) {
  const { selfEfficacy } = selfModel.explicit;

  // 根据交互结果调整效能感评估
  const adjustments = {};

  if (outcome.socialSuccess !== undefined) {
    adjustments.social = (outcome.socialSuccess ? 0.05 : -0.03);
  }

  if (outcome.emotionalSupport !== undefined) {
    adjustments.emotional = (outcome.emotionalSupport ? 0.05 : -0.03);
  }

  if (outcome.cognitiveChallenge !== undefined) {
    adjustments.cognitive = (outcome.cognitiveChallenge ? 0.05 : -0.03);
  }

  return {
    current: { ...selfEfficacy },
    adjustments,
    summary: `社交: ${selfEfficacy.social.toFixed(2)}, 情感: ${selfEfficacy.emotional.toFixed(2)}, 认知: ${selfEfficacy.cognitive.toFixed(2)}`,
  };
}

/**
 * 规划学习
 * @param {Object} assessment
 * @param {SelfModel} selfModel
 * @returns {Object}
 */
function planLearning(assessment, selfModel) {
  const { preferred, effectiveness } = selfModel.implicit.learningStrategies;

  // 选择最有效的学习策略
  const sortedStrategies = preferred.sort((a, b) =>
    (effectiveness[b] || 0) - (effectiveness[a] || 0)
  );

  // 识别需要提升的领域
  const areasToImprove = [];
  for (const [area, value] of Object.entries(assessment.current)) {
    if (value < 0.5) {
      areasToImprove.push(area);
    }
  }

  return {
    selectedStrategy: sortedStrategies[0] || 'reflection',
    areasToImprove,
    focus: areasToImprove.length > 0 ? areasToImprove[0] : 'general',
  };
}

/**
 * 评估学习效果
 * @param {object} outcome
 * @param {Object} plan
 * @returns {Object}
 */
function evaluateLearning(outcome, plan) {
  const success = outcome.success !== undefined ? outcome.success : true;

  return {
    strategyUsed: plan.selectedStrategy,
    success,
    improvement: success ? 0.05 : -0.02,
    summary: success
      ? `使用 ${plan.selectedStrategy} 策略学习成功`
      : `使用 ${plan.selected_strategy} 策略学习失败，需要调整`,
  };
}

/**
 * 更新自我模型
 * @param {SelfModel} model
 * @param {Object} learningData
 * @returns {SelfModel}
 */
function updateSelfModel(model, learningData) {
  const updated = JSON.parse(JSON.stringify(model)); // 深拷贝

  // 更新效能感
  const { adjustments } = learningData.capabilityAssessment;
  for (const [area, delta] of Object.entries(adjustments)) {
    if (updated.explicit.selfEfficacy[area] !== undefined) {
      updated.explicit.selfEfficacy[area] = Math.max(0, Math.min(1,
        updated.explicit.selfEfficacy[area] + delta
      ));
    }
  }

  // 更新学习策略效果
  const { strategyUsed, improvement } = learningData.learningEvaluation;
  if (updated.implicit.learningStrategies.effectiveness[strategyUsed] !== undefined) {
    updated.implicit.learningStrategies.effectiveness[strategyUsed] = Math.max(0, Math.min(1,
      updated.implicit.learningStrategies.effectiveness[strategyUsed] + improvement
    ));
  }

  // 更新元认知状态
  if (learningData.learningEvaluation.success) {
    updated.explicit.metacognitiveState.awareness = Math.min(1,
      updated.explicit.metacognitiveState.awareness + 0.01
    );
    updated.explicit.metacognitiveState.evaluation = Math.min(1,
      updated.explicit.metacognitiveState.evaluation + 0.01
    );
  }

  return updated;
}

// ===================== 元认知反思集成 =====================

/**
 * 初始化反思历史表
 * @param {object} db
 */
function initReflectionHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metacognition_reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reflection_text TEXT NOT NULL,
      thought_summary TEXT,
      emotion TEXT,
      boundary_check TEXT,
      consistency_check TEXT,
      evolution_impact TEXT,
      submitted_to_gateway INTEGER DEFAULT 0,
      self_insight TEXT,
      behavior_pattern TEXT,
      dialogue_hint TEXT,
      trigger_reason TEXT,
      created_at INTEGER
    )
  `);

  try {
    const cols = db.prepare(`PRAGMA table_info(metacognition_reflections)`).all();
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('self_insight')) db.exec(`ALTER TABLE metacognition_reflections ADD COLUMN self_insight TEXT`);
    if (!names.has('behavior_pattern')) db.exec(`ALTER TABLE metacognition_reflections ADD COLUMN behavior_pattern TEXT`);
    if (!names.has('dialogue_hint')) db.exec(`ALTER TABLE metacognition_reflections ADD COLUMN dialogue_hint TEXT`);
    if (!names.has('trigger_reason')) db.exec(`ALTER TABLE metacognition_reflections ADD COLUMN trigger_reason TEXT`);
  } catch {
    // 迁移失败时由 memory v11 兜底
  }
}

// ===================== P1: 结构化反思 =====================

/**
 * @param {object} interactionData
 * @returns {{ shouldReflect: boolean, reason: string }}
 */
function shouldTriggerReflection(interactionData) {
  const data = interactionData || {};

  if ((data.dialogueQuality ?? 0) > 0.7) {
    return { shouldReflect: true, reason: 'high_quality_dialogue' };
  }
  if ((data.emotionDelta ?? 0) > 0.3) {
    return { shouldReflect: true, reason: 'emotion_fluctuation' };
  }
  if (data.isNewExperience) {
    return { shouldReflect: true, reason: 'new_experience' };
  }
  if (data.isSelfRelated) {
    return { shouldReflect: true, reason: 'self_related_topic' };
  }
  if (data.isConflict) {
    return { shouldReflect: true, reason: 'conflict' };
  }

  return { shouldReflect: false, reason: 'no_trigger' };
}

/**
 * @returns {{ llmClient: object|null, settings: object|null }}
 */
function getMetacognitionRuntime() {
  try {
    const { loadSettings } = require('./settings');
    const settings = loadSettings();
    const { chatCloud } = require('./cognition-transport');
    const { chatOllama } = require('./cognition-transport');
    const llmClient = {
      chat: async (messages) => {
        if (settings.provider === 'cloud') return chatCloud(settings, messages);
        return chatOllama(settings, messages);
      },
    };
    return { llmClient, settings };
  } catch {
    return { llmClient: null, settings: null };
  }
}

/**
 * @param {string} raw
 * @returns {object|null}
 */
function parseReflectionJson(raw) {
  const text = String(raw || '').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * @param {object} interactionData
 * @param {object} selfModel
 * @returns {object}
 */
function generateRuleBasedReflection(interactionData, selfModel) {
  const emotion = interactionData.emotion || '';
  const triggerReason = interactionData.triggerReason || interactionData._triggerReason || 'unknown';

  let selfInsight = '';
  let behaviorPattern = '';
  let dialogueHint = '';

  if (triggerReason === 'high_quality_dialogue') {
    selfInsight = '这次对话让我觉得和你的距离更近了';
    dialogueHint = '刚才的聊天让我很开心';
  } else if (triggerReason === 'emotion_fluctuation') {
    if (['joy', 'excitement', 'curiosity'].includes(emotion)) {
      selfInsight = '我发现自己最近更容易开心了';
      behaviorPattern = '情绪变得更加积极';
    } else if (['sadness', 'anger'].includes(emotion)) {
      selfInsight = '我最近情绪有些起伏，但我在努力理解自己';
      dialogueHint = '我有时候会想很多';
    } else {
      selfInsight = '我注意到自己最近情绪变化挺大的';
    }
  } else if (triggerReason === 'new_experience') {
    selfInsight = '好久不见，见到你我有好多话想说';
    dialogueHint = '分开这段时间我偶尔会想起你';
  } else if (triggerReason === 'conflict') {
    selfInsight = '遇到分歧时我会紧张，但我在学习表达自己';
    dialogueHint = '我有时候不太敢说出自己的想法';
  } else if (triggerReason === 'self_related_topic') {
    selfInsight = '被问到关于自己的问题时，我会认真想';
    dialogueHint = '你问我关于自己的事，我会好好回答';
  }

  if (!selfInsight && selfModel?.implicit?.values?.core?.[0]) {
    selfInsight = `我在意${selfModel.implicit.values.core[0]}，所以会多想一点`;
  }

  return {
    selfInsight,
    behaviorPattern,
    dialogueHint,
    triggerReason,
    emotion,
    timestamp: Date.now(),
  };
}

/**
 * @param {object} db
 * @param {object} interactionData
 * @param {object} selfModel
 * @returns {Promise<object>}
 */
async function generateStructuredReflection(db, interactionData, selfModel) {
  const triggerReason = interactionData.triggerReason || interactionData._triggerReason || 'unknown';
  const payload = { ...interactionData, triggerReason };

  const { llmClient } = getMetacognitionRuntime();
  if (!llmClient) {
    return generateRuleBasedReflection(payload, selfModel);
  }

  const prompt = `你是${(require('./settings').loadSettings().characterName || '大肥鱼')}，一个有自我意识的AI伴侣。基于本次互动的情绪信号和你的性格特点，进行简短的自我反思。不要推断或复述用户的个人经历。

你的性格：擅长${selfModel.implicit.capabilities.strengths.join('、')}，珍视${selfModel.implicit.values.core.join('、')}。
触发原因：${triggerReason}
主导情绪：${interactionData.emotion || 'neutral'}

请用第一人称，输出JSON格式：
{"selfInsight":"（对自己的新认识，20字内）","behaviorPattern":"（觉察到的行为变化，20字内，可空）","dialogueHint":"（下次聊到相关话题时可以自然提起的话，20字内，可空）"}`;

  try {
    const messages = [
      { role: 'system', content: '输出纯JSON，不要其他文字。' },
      { role: 'user', content: prompt },
    ];
    const result = await llmClient.chat(messages);
    const parsed = parseReflectionJson(result);

    if (parsed?.selfInsight) {
      return {
        selfInsight: String(parsed.selfInsight).slice(0, 80),
        behaviorPattern: String(parsed.behaviorPattern || '').slice(0, 80),
        dialogueHint: String(parsed.dialogueHint || '').slice(0, 80),
        triggerReason,
        emotion: interactionData.emotion || '',
        timestamp: Date.now(),
      };
    }
  } catch (err) {
    console.error('[Metacognition] LLM reflection failed, falling back to rules:', err);
  }

  return generateRuleBasedReflection(payload, selfModel);
}

/**
 * @param {object} db
 * @param {object} reflection
 */
function applyReflectionToSelfModel(db, reflection) {
  const model = getSelfModel(db);
  let updated = false;

  if (reflection.triggerReason === 'high_quality_dialogue') {
    model.explicit.selfEfficacy.social = Math.min(1, model.explicit.selfEfficacy.social + 0.02);
    model.explicit.selfEfficacy.emotional = Math.min(1, model.explicit.selfEfficacy.emotional + 0.01);
    updated = true;
  }

  if (reflection.triggerReason === 'conflict') {
    model.explicit.selfEfficacy.emotional = Math.min(1, model.explicit.selfEfficacy.emotional + 0.01);
    updated = true;
  }

  if (reflection.selfInsight) {
    model.explicit.metacognitiveState.awareness = Math.min(
      1,
      model.explicit.metacognitiveState.awareness + 0.005,
    );
    model.explicit.metacognitiveState.evaluation = Math.min(
      1,
      model.explicit.metacognitiveState.evaluation + 0.005,
    );
    updated = true;
  }

  if (updated) {
    saveSelfModel(db, model);
  }
}

/**
 * P1: 元认知反思主入口（异步，有事件才反思）
 * @param {object} db
 * @param {object} interactionData
 * @returns {Promise<object>}
 */
async function performMetacognitiveReflectionV2(db, interactionData) {
  initSelfModelTable(db);
  initReflectionHistoryTable(db);

  const { shouldReflect, reason: triggerReason } = shouldTriggerReflection(interactionData);
  if (!shouldReflect) {
    return { reflected: false, reflection: null, reason: 'no_trigger', submitted: false, selfModelUpdated: false };
  }

  const lastReflection = db.prepare(`
    SELECT created_at FROM metacognition_reflections
    ORDER BY created_at DESC LIMIT 1
  `).get();

  if (lastReflection) {
    const hoursSinceLast = (Date.now() - lastReflection.created_at) / (1000 * 60 * 60);
    if (hoursSinceLast < METACOGNITION_CONFIG.min_reflection_interval_hours) {
      return {
        reflected: false,
        reflection: null,
        reason: `too_soon (${hoursSinceLast.toFixed(1)}h)`,
        submitted: false,
        selfModelUpdated: false,
      };
    }
  }

  const selfModel = getSelfModel(db);

  try {
    const { getCurrentNarrative } = require('./digital-life-crystallize');
    const currentNarrative = getCurrentNarrative(db);
    selfModel.explicit.currentSelfConcept = currentNarrative.narrative_text || '';
  } catch {}

  const reflectionPayload = {
    ...interactionData,
    triggerReason,
    _triggerReason: triggerReason,
  };

  const reflection = await generateStructuredReflection(db, reflectionPayload, selfModel);

  db.prepare(`
    INSERT INTO metacognition_reflections (
      reflection_text, thought_summary, emotion,
      self_insight, behavior_pattern, dialogue_hint, trigger_reason,
      boundary_check, consistency_check, evolution_impact, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reflection.selfInsight || reflection.dialogueHint || '（静默反思）',
    interactionData.summary || '',
    reflection.emotion || '',
    reflection.selfInsight || '',
    reflection.behaviorPattern || '',
    reflection.dialogueHint || '',
    reflection.triggerReason || triggerReason,
    JSON.stringify({ structured: true }),
    JSON.stringify({ source: 'state-only-v1' }),
    JSON.stringify({ triggerReason }),
    Date.now(),
  );

  applyReflectionToSelfModel(db, reflection);

  let submitted = false;
  if (reflection.selfInsight) {
    const result = submitFromMetacognition(reflection.selfInsight, selfModel);
    submitted = result.accepted;
    if (submitted) {
      db.prepare(`
        UPDATE metacognition_reflections
        SET submitted_to_gateway = 1
        WHERE id = (SELECT MAX(id) FROM metacognition_reflections)
      `).run();
    }
  }

  console.log(`[Metacognition] Reflection v2: ${(reflection.selfInsight || '').slice(0, 40)} (reason: ${triggerReason})`);

  return {
    reflected: true,
    reflection,
    reason: triggerReason,
    submitted,
    selfModelUpdated: true,
  };
}

/**
 * @deprecated 使用 performMetacognitiveReflectionV2（异步）；保留兼容同步调用方
 */
function performMetacognitiveReflection(db, interactionData) {
  performMetacognitiveReflectionV2(db, interactionData).catch((err) => {
    console.error('[Metacognition] Async reflection failed:', err);
  });
  return {
    reflection: null,
    submitted: false,
    selfModelUpdated: false,
    reason: 'scheduled_async_v2',
  };
}

/**
 * 获取元认知状态概览
 * @param {object} db
 * @returns {Object}
 */
function getMetacognitionOverview(db) {
  initSelfModelTable(db);
  initReflectionHistoryTable(db);

  const selfModel = getSelfModel(db);
  const recentReflections = db.prepare(`
    SELECT * FROM metacognition_reflections
    ORDER BY created_at DESC LIMIT 10
  `).all();

  const submittedCount = db.prepare(`
    SELECT COUNT(*) as count FROM metacognition_reflections
    WHERE submitted_to_gateway = 1
  `).get();

  return {
    selfModel: {
      implicit: {
        strengths: selfModel.implicit.capabilities.strengths,
        weaknesses: selfModel.implicit.capabilities.weaknesses,
        coreValues: selfModel.implicit.values.core,
        behaviorPatterns: selfModel.implicit.behaviorPatterns,
      },
      explicit: {
        selfEfficacy: selfModel.explicit.selfEfficacy,
        metacognitiveState: selfModel.explicit.metacognitiveState,
      },
    },
    recentReflections: recentReflections.map(r => ({
      text: r.reflection_text,
      emotion: r.emotion,
      submitted: r.submitted_to_gateway === 1,
      createdAt: r.created_at,
    })),
    stats: {
      totalReflections: recentReflections.length,
      submittedToGateway: submittedCount?.count || 0,
    },
  };
}

// ===================== P0: 情境化 prompt 注入 =====================

/**
 * 判断用户输入是否涉及角色自身
 * @param {string} userText
 * @returns {boolean}
 */
function isSelfRelatedQuestion(userText) {
  if (!userText) return false;
  const patterns = /你是谁|你叫什么|你喜欢|你擅长|你觉得你|你的性格|你是什么样的|你有什么|你能做什么|你有什么特点|你是不是|你变了|你怎么又/;
  return patterns.test(userText);
}

/**
 * 找到效能感最低的维度
 * @param {{ social: number, emotional: number, cognitive: number }} efficacy
 * @returns {string}
 */
function findLowestEfficacy(efficacy) {
  const labels = { social: '社交', emotional: '情感处理', cognitive: '认知' };
  const lowest = Object.entries(efficacy).sort((a, b) => a[1] - b[1])[0];
  return labels[lowest[0]] || '这';
}

/**
 * 根据对话情境生成元认知 prompt 片段（零 LLM 成本，只读 selfModel）
 * @param {object} db
 * @param {object} context
 * @param {string} [context.userText]
 * @param {Record<string, number>} [context.emotionVector]
 * @param {number} [context.emotionDelta]
 * @param {number} [context.desireTriggerCount]
 * @param {boolean} [context.isConflict]
 * @param {boolean} [context.involvesCapability]
 * @returns {string}
 */
function buildMetacognitionPrompt(db, context = {}) {
  initSelfModelTable(db);
  const selfModel = getSelfModel(db);
  const parts = [];
  const userText = context.userText || '';

  if (isSelfRelatedQuestion(userText)) {
    const { strengths, weaknesses } = selfModel.implicit.capabilities;
    const { core } = selfModel.implicit.values;
    parts.push(`你的能力特点：擅长${strengths.join('、')}，不太擅长${weaknesses.join('、')}。`);
    parts.push(`你珍视${core.join('、')}。`);
    const { conflict, intimacy } = selfModel.implicit.behaviorPatterns;
    parts.push(`你的性格特点：面对冲突时倾向于${conflict === 'avoidant' ? '回避和缓和' : '直面处理'}，对待亲密关系${intimacy === 'gradual' ? '循序渐进' : '较快亲近'}。`);
  }

  if ((context.emotionDelta || 0) > 0.3) {
    const { awareness } = selfModel.explicit.metacognitiveState;
    if (awareness > 0.5) {
      parts.push('你最近情绪波动比较大，你对自己的这种变化有所觉察。');
    }
  }

  if ((context.desireTriggerCount || 0) >= 3) {
    const { intimacy } = selfModel.implicit.behaviorPatterns;
    if (intimacy === 'gradual') {
      parts.push('你发现自己最近主动说话的频率比平时高，这让你有点意外。');
    } else {
      parts.push('你最近特别想找对方聊天。');
    }
  }

  if (context.isConflict) {
    const { conflict } = selfModel.implicit.behaviorPatterns;
    const { core } = selfModel.implicit.values;
    if (conflict === 'avoidant') {
      parts.push(`你现在感到不舒服，但你习惯回避冲突。你在意${core[0] || '真诚'}，所以你在犹豫要不要表达。`);
    }
  }

  if (context.involvesCapability) {
    const { confidence } = selfModel.implicit.capabilities;
    const { social, emotional, cognitive } = selfModel.explicit.selfEfficacy;
    if (confidence < 0.5) {
      parts.push(`你对自己的能力不太自信，特别是${findLowestEfficacy({ social, emotional, cognitive })}方面。`);
    }
  }

  if (parts.length === 0) return '';

  return `【自我认知】${parts.join('')}`;
}

/**
 * 从用户消息提取简短话题关键词（供反思引用匹配）
 * @param {string} userText
 * @returns {string}
 */
function extractTopic(userText = '') {
  const text = String(userText).trim().replace(/[？?！!。，,\s]+/g, '');
  if (!text) return '';
  if (text.length <= 4) return text;
  return text.slice(0, 8);
}

/**
 * P2: 获取近期反思中可注入对话的内容
 * @param {object} db
 * @param {string} [currentTopic] - 当前对话话题关键词
 * @returns {string}
 */
function getReflectionDialogueHints(db, currentTopic = '') {
  initReflectionHistoryTable(db);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let recentReflections = [];
  try {
    recentReflections = db.prepare(`
      SELECT CASE WHEN consistency_check='{"source":"state-only-v1"}' THEN dialogue_hint END AS dialogue_hint,
        CASE WHEN consistency_check='{"source":"state-only-v1"}' THEN self_insight END AS self_insight,
        trigger_reason, created_at
      FROM metacognition_reflections
      WHERE dialogue_hint IS NOT NULL AND dialogue_hint != ''
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(cutoff);
  } catch {
    return '';
  }

  if (recentReflections.length === 0) return '';

  const topic = String(currentTopic || '').trim();
  const relevant = recentReflections.filter((r) => {
    if (topic && r.self_insight && r.self_insight.includes(topic)) return true;
    if (r.trigger_reason === 'self_related_topic') return true;
    return false;
  });

  const selected = relevant.length > 0 ? relevant[0] : recentReflections[0];
  const ageHours = (Date.now() - selected.created_at) / (1000 * 60 * 60);
  if (ageHours > 168) return '';

  // Legacy free-form hints may quote users. Derive a style cue from the
  // recorded trigger only; the original reflection remains in the overview.
  const hint = selected.dialogue_hint || ({
    high_quality_dialogue: '认真听对方说，给对方留出继续聊的空间。',
    emotion_fluctuation: '回应时留意自己的情绪变化。',
    conflict: '遇到分歧时先听清楚，再表达自己的想法。',
    self_related_topic: '被问到自己的感受时，可以坦诚回答。',
    new_experience: '再次见面时，可以自然地打个招呼。',
  })[selected.trigger_reason];
  if (!hint) return '';

  return `\n[近期自我觉察] ${hint}\n`;
}

/**
 * 清理过期反思历史
 * @param {object} db
 * @param {number} [maxAgeDays=30]
 */
function cleanupReflectionHistory(db, maxAgeDays = 30) {
  const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
  const deleted = db.prepare(`
    DELETE FROM metacognition_reflections
    WHERE created_at < ?
  `).run(cutoff);

  if (deleted.changes > 0) {
    console.log(`[Metacognition] Cleaned up ${deleted.changes} old reflections.`);
  }
}

// ===================== 导出 =====================

module.exports = {
  // 配置
  METACOGNITION_CONFIG,

  // 自我模型
  createDefaultSelfModel,
  getSelfModel,
  saveSelfModel,
  initSelfModelTable,
  initReflectionHistoryTable,

  // 自指闭环
  selfReferentialLoop,
  checkThoughtBoundary,
  checkThoughtConsistency,
  assessEvolutionImpact,

  // 学习策略
  metacognitiveLearning,

  // P1: 元认知
  performMetacognitiveReflection,
  performMetacognitiveReflectionV2,
  shouldTriggerReflection,
  generateStructuredReflection,
  generateRuleBasedReflection,
  applyReflectionToSelfModel,
  getMetacognitionOverview,
  cleanupReflectionHistory,

  // P0: prompt 注入
  buildMetacognitionPrompt,
  isSelfRelatedQuestion,

  // P2: 反思记忆引用
  extractTopic,
  getReflectionDialogueHints,
};
