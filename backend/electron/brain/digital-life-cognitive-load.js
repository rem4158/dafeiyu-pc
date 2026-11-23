// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 认知负荷自适应模块 (Step 6)
 * 评估用户消息的认知复杂度，自适应调整回复的深度和长度
 *
 * 设计原则：
 * - 简单问题 → 简短轻松回复
 * - 深度问题 → 详细深入回复
 * - 情绪低落时 → 降低认知要求，语气温柔
 * - 不影响情绪向量，只影响 prompt 提示
 */

// ============================================================
// 认知负荷评估
// ============================================================

/**
 * @typedef {object} CognitiveLoad
 * @property {'low'|'medium'|'high'} intrinsic - 内在负荷（话题本身的复杂度）
 * @property {'relaxed'|'normal'|'stressed'} userState - 用户状态推断
 * @property {'simple'|'moderate'|'complex'} contextComplexity - 上下文复杂度
 * @property {number} overallScore - 综合评分 0-1
 */

/**
 * 评估用户消息的认知负荷
 * @param {string} userText - 用户消息
 * @param {object} [options] - 可选上下文
 * @param {object} [options.emotionVector] - 当前情绪向量
 * @param {number} [options.conversationTurn] - 当前对话轮次
 * @param {number} [options.messageLength] - 消息长度
 * @returns {CognitiveLoad}
 */
function assessCognitiveLoad(userText, options = {}) {
  const text = userText || '';

  const intrinsic = assessIntrinsicLoad(text);
  const userState = inferUserState(text, options.emotionVector);
  const contextComplexity = assessContextComplexity(text, options.conversationTurn);

  // 综合评分
  const intrinsicScore = { low: 0.2, medium: 0.5, high: 0.9 }[intrinsic];
  const stateScore = { relaxed: 0.2, normal: 0.5, stressed: 0.8 }[userState];
  const contextScore = { simple: 0.2, moderate: 0.5, complex: 0.8 }[contextComplexity];

  const overallScore = intrinsicScore * 0.5 + stateScore * 0.25 + contextScore * 0.25;

  return {
    intrinsic,
    userState,
    contextComplexity,
    overallScore: Math.max(0, Math.min(1, overallScore)),
  };
}

// ============================================================
// 内在负荷评估
// ============================================================

/** 评估话题本身的复杂度 */
function assessIntrinsicLoad(text) {
  // 简单模式：问候、确认、简单事实查询
  const simplePatterns = [
    /(?:你好|嗨|嗯|哦|好的|对|不是|谢谢|晚安|早安|拜拜)/,
    /(?:是什么|几点|天气|多大|在哪|怎么去|多少钱)/,
    /(?:帮我|帮我查|帮我看看)/,
  ];
  if (simplePatterns.some(p => p.test(text))) return 'low';

  // 高复杂度模式：分析、推理、比较、反思
  const complexPatterns = [
    /(?:为什么|怎么理解|分析|比较|解释一下|有什么区别|你觉得呢|你怎么看)/,
    /(?:如果.*那么|假设|推理|论证|辩证|矛盾|本质|深层)/,
    /(?:人生|哲学|意义|价值|存在|自由|选择|命运)/,
    /(?:设计|架构|方案|策略|优化|改进)/,
  ];
  if (complexPatterns.some(p => p.test(text))) return 'high';

  // 中等模式：描述、叙述、一般提问
  return 'medium';
}

// ============================================================
// 用户状态推断
// ============================================================

/** 推断用户当前的情绪/认知状态 */
function inferUserState(text, emotionVector) {
  // 压力信号
  const stressSignals = [
    /(?:累|烦|焦虑|压力大|头疼|崩溃|受不了|太多了|忙死了)/,
    /(?:！{2,}|！{2,}|啊{2,}|哈{3,})/,
  ];
  if (stressSignals.some(p => p.test(text))) return 'stressed';

  // 放松信号
  const relaxedSignals = [
    /(?:哈哈|嘿嘿|嘻嘻|开心|好棒|不错|舒服|惬意|悠闲)/,
    /(?:～{2,}|~{2,})/,
  ];
  if (relaxedSignals.some(p => p.test(text))) return 'relaxed';

  // 从情绪向量推断（如果提供）
  if (emotionVector) {
    if (emotionVector.sadness > 0.6 || emotionVector.anger > 0.6) return 'stressed';
    if (emotionVector.joy > 0.6 || emotionVector.contentment > 0.6) return 'relaxed';
  }

  return 'normal';
}

// ============================================================
// 上下文复杂度
// ============================================================

/** 评估对话上下文的复杂度 */
function assessContextComplexity(text, conversationTurn = 0) {
  let score = 0;

  // 消息长度
  if (text.length > 100) score += 2;
  else if (text.length > 40) score += 1;

  // 是否包含多个问题
  const questions = text.match(/[？?]/g);
  if (questions && questions.length >= 2) score += 1;

  // 对话深度（越深越复杂）
  if (conversationTurn > 10) score += 1;

  // 包含代码或技术内容
  if (/[`{}\[\]<>]/.test(text) || /(?:代码|程序|bug|报错|API|函数|变量)/i.test(text)) {
    score += 1;
  }

  if (score >= 3) return 'complex';
  if (score >= 1) return 'moderate';
  return 'simple';
}

// ============================================================
// Prompt 构建
// ============================================================

/**
 * 构建认知负荷自适应 prompt 块（单条最高优先级）
 * @param {CognitiveLoad} load - 评估结果
 * @returns {{ text: string, priority: number } | null}
 */
function getCognitiveLoadToneCandidate(load) {
  /** @type {{ text: string, priority: number }[]} */
  const candidates = [];

  if (load.userState === 'stressed') {
    candidates.push({ text: '用户可能压力较大，语气温柔一些，尽量避免追问太多', priority: 9 });
  }

  if (load.intrinsic === 'high') {
    candidates.push({ text: '若合适，可认真思考后给出有深度的回应', priority: 7 });
  }

  if (load.userState === 'relaxed') {
    candidates.push({ text: '用户心情似乎不错，可稍活泼一些，但不要编造事实来凑气氛', priority: 6 });
  }

  if (load.intrinsic === 'low') {
    candidates.push({ text: '回复简短轻松，一两句话即可', priority: 5 });
  }

  if (load.overallScore > 0.7) {
    candidates.push({ text: '这个问题值得认真回答', priority: 6.5 });
  } else if (load.overallScore < 0.3) {
    candidates.push({ text: '轻松回应就好', priority: 4 });
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}

/**
 * 构建认知负荷自适应 prompt 块
 * @param {CognitiveLoad} load - 评估结果
 * @returns {string} prompt 文本
 */
function buildCognitiveLoadPrompt(load) {
  const candidate = getCognitiveLoadToneCandidate(load);
  if (!candidate) return '';
  return `【回应调适】${candidate.text}。`;
}

/**
 * 完整的认知负荷评估 + prompt 生成
 * @param {string} userText - 用户消息
 * @param {object} [options] - 可选上下文
 * @returns {{ load: CognitiveLoad, promptBlock: string }}
 */
function adaptiveResponse(userText, options = {}) {
  const load = assessCognitiveLoad(userText, options);
  const promptBlock = buildCognitiveLoadPrompt(load);

  return { load, promptBlock };
}

module.exports = {
  assessCognitiveLoad,
  buildCognitiveLoadPrompt,
  getCognitiveLoadToneCandidate,
  adaptiveResponse,
};
