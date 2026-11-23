/**
 * 数字生命系统 - 语言互惠模块 (Step 6)
 * 分析用户语言风格，生成匹配提示，让莉莉安的语言风格自然贴近用户
 *
 * 设计原则：
 * - 不是模仿，而是"心理接近"——用户用简单语言，她也简短；用户深沉，她也深入
 * - 风格维度独立于情绪系统，互不干扰
 * - 只在 prompt 层面影响，不修改情绪向量
 */

// ============================================================
// 风格维度定义
// ============================================================

/**
 * @typedef {object} LinguisticStyle
 * @property {'simple'|'medium'|'complex'} complexity - 语言复杂度
 * @property {'light'|'moderate'|'deep'} emotionDepth - 情感深度
 * @property {'casual'|'mixed'|'formal'} formality - 正式程度
 * @property {'none'|'light'|'heavy'} humor - 幽默程度
 * @property {'short'|'medium'|'long'} avgLength - 平均消息长度
 */

/**
 * 分析用户消息的语言风格
 * @param {string} userText - 用户消息
 * @returns {LinguisticStyle}
 */
function analyzeUserStyle(userText) {
  const text = userText || '';
  const len = text.length;

  return {
    complexity: assessComplexity(text),
    emotionDepth: assessEmotionDepth(text),
    formality: assessFormality(text),
    humor: assessHumor(text),
    avgLength: len <= 10 ? 'short' : len <= 50 ? 'medium' : 'long',
  };
}

/**
 * 基于历史交互分析用户的综合风格倾向
 * 取最近几条消息的风格做加权平均
 * @param {string[]} recentMessages - 最近的用户消息数组
 * @returns {LinguisticStyle}
 */
function analyzeUserStyleFromHistory(recentMessages) {
  if (!recentMessages || recentMessages.length === 0) {
    return { complexity: 'medium', emotionDepth: 'moderate', formality: 'casual', humor: 'light', avgLength: 'medium' };
  }

  // 对每条消息分析风格，然后投票决定最终风格
  const styles = recentMessages.map(analyzeUserStyle);

  return {
    complexity: voteDimension(styles.map(s => s.complexity), ['simple', 'medium', 'complex']),
    emotionDepth: voteDimension(styles.map(s => s.emotionDepth), ['light', 'moderate', 'deep']),
    formality: voteDimension(styles.map(s => s.formality), ['casual', 'mixed', 'formal']),
    humor: voteDimension(styles.map(s => s.humor), ['none', 'light', 'heavy']),
    avgLength: voteDimension(styles.map(s => s.avgLength), ['short', 'medium', 'long']),
  };
}

// ============================================================
// 风格分析辅助函数
// ============================================================

/** 判断语言复杂度 */
function assessComplexity(text) {
  let score = 0;

  // 长度因子
  if (text.length > 80) score += 2;
  else if (text.length > 30) score += 1;

  // 复杂词汇检测
  const complexWords = /(?:因此|然而|尽管|虽然|不过|而且|并且|或者|假设|结论|分析|综合|辩证|矛盾|本质|现象)/g;
  const matches = text.match(complexWords);
  if (matches) score += matches.length;

  // 多层句式
  if (/[，,].*[，,].*[，,]/.test(text)) score += 1;

  // 英文混合（代码/学术场景）
  if (/[a-zA-Z]{3,}/.test(text)) score += 1;

  if (score >= 3) return 'complex';
  if (score >= 1) return 'medium';
  return 'simple';
}

/** 判断情感深度 */
function assessEmotionDepth(text) {
  let score = 0;

  // 深度情感词汇
  const deepEmotionWords = /(?:感觉|觉得|内心|心情|难过|开心|感动|害怕|焦虑|孤独|幸福|委屈|失落|温暖|感激|珍惜|想念|思念)/g;
  const deepMatches = text.match(deepEmotionWords);
  if (deepMatches) score += deepMatches.length * 2;

  // 个人分享词汇
  const personalWords = /(?:我觉得|我想|我希望|我害怕|我担心|我希望|对我来说|其实|说实话|心里)/g;
  const personalMatches = text.match(personalWords);
  if (personalMatches) score += personalMatches.length;

  // 省略号/感叹号（情感表达）
  if (/[…！!]{2,}/.test(text)) score += 1;

  // 表情符号（使用具体匹配而非范围，避免 Unicode 范围问题）
  if (/[\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}]/u.test(text)) score += 1;

  if (score >= 4) return 'deep';
  if (score >= 1) return 'moderate';
  return 'light';
}

/** 判断正式程度 */
function assessFormality(text) {
  let score = 0;

  // 正式用语
  const formalWords = /(?:您好|请问|能否|是否|感谢|此致|敬礼|告知|协助|处理|安排)/g;
  const formalMatches = text.match(formalWords);
  if (formalMatches) score += formalMatches.length * 2;

  // 非正式用语
  const casualWords = /(?:哈哈|嘿嘿|嘻嘻|哎呀|啊|呢|吧|嘛|哦|嗯|啦|呀|哈|噢|唔|emmm|haha|lol|hhh)/gi;
  const casualMatches = text.match(casualWords);
  if (casualMatches) score -= casualMatches.length;

  // 网络用语
  const slangWords = /(?:yyds|绝绝子|无语|尬|社死|破防|家人们|宝子|集美|老铁)/g;
  const slangMatches = text.match(slangWords);
  if (slangMatches) score -= slangMatches.length * 2;

  if (score >= 2) return 'formal';
  if (score <= -1) return 'casual';
  return 'mixed';
}

/** 判断幽默程度 */
function assessHumor(text) {
  let score = 0;

  // 幽默词汇
  const humorWords = /(?:哈哈哈|笑死|绝了|哈哈|笑|噗|233|草|hhh|lmao|lol|doge|🤡|😂|🤣)/gi;
  const humorMatches = text.match(humorWords);
  if (humorMatches) score += humorMatches.length;

  // 反讽/调侃模式
  if (/（.*）/.test(text) || /\(.*\)/.test(text)) score += 1;
  if (/[~～]{2,}/.test(text)) score += 1;

  if (score >= 3) return 'heavy';
  if (score >= 1) return 'light';
  return 'none';
}

/** 投票决定维度值 */
function voteDimension(values, orderedOptions) {
  if (!values.length) return orderedOptions[1] || orderedOptions[0];

  const counts = {};
  for (const opt of orderedOptions) counts[opt] = 0;
  for (const v of values) {
    if (counts[v] !== undefined) counts[v]++;
  }

  // 返回出现最多的值
  let maxCount = 0;
  let result = orderedOptions[0];
  for (const opt of orderedOptions) {
    if (counts[opt] > maxCount) {
      maxCount = counts[opt];
      result = opt;
    }
  }
  return result;
}

// ============================================================
// Prompt 构建
// ============================================================

/**
 * 构建语言互惠 prompt 块（单条最高优先级）
 * @param {LinguisticStyle} style - 用户风格分析结果
 * @returns {{ text: string, priority: number } | null}
 */
function getLinguisticToneCandidate(style) {
  /** @type {{ text: string, priority: number }[]} */
  const candidates = [];

  switch (style.complexity) {
    case 'simple':
      candidates.push({ text: '用简短直白的语言回应，避免长句和复杂词汇', priority: 7 });
      break;
    case 'complex':
      candidates.push({ text: '若合适，可用更丰富的词汇和更完整的句式', priority: 6 });
      break;
  }

  switch (style.emotionDepth) {
    case 'deep':
      candidates.push({ text: '若合适，可回应用户的情感，表达理解', priority: 8 });
      break;
    case 'light':
      candidates.push({ text: '保持轻松的语气，不过度深挖情感', priority: 5 });
      break;
  }

  switch (style.avgLength) {
    case 'short':
      candidates.push({ text: '回复也尽量简短，一两句话即可', priority: 7.5 });
      break;
    case 'long':
      candidates.push({ text: '若合适，可更详细回应', priority: 6 });
      break;
  }

  switch (style.formality) {
    case 'formal':
      candidates.push({ text: '语气可稍正式一些，但保持亲切', priority: 4 });
      break;
    case 'casual':
      candidates.push({ text: '用轻松随意的语气，像朋友聊天', priority: 5 });
      break;
  }

  switch (style.humor) {
    case 'heavy':
      candidates.push({ text: '若合适，可适当加入幽默和俏皮的表达', priority: 4.5 });
      break;
    case 'none':
      candidates.push({ text: '保持真诚自然，不刻意搞笑', priority: 4 });
      break;
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.priority - a.priority)[0];
}

/**
 * 将 LinguisticStyle 转为 profile.tone 可持久化的短句
 * @param {LinguisticStyle} style
 * @returns {string}
 */
function styleToToneDescription(style) {
  if (!style) return '';

  /** @type {string[]} */
  const parts = [];

  switch (style.complexity) {
    case 'simple':
      parts.push('语言简短直白');
      break;
    case 'complex':
      parts.push('用词较丰富');
      break;
    default:
      break;
  }

  switch (style.emotionDepth) {
    case 'deep':
      parts.push('情感分享较深');
      break;
    case 'light':
      parts.push('语气轻松');
      break;
    default:
      break;
  }

  switch (style.formality) {
    case 'formal':
      parts.push('偏正式');
      break;
    case 'casual':
      parts.push('像朋友聊天');
      break;
    default:
      break;
  }

  switch (style.avgLength) {
    case 'short':
      parts.push('消息偏短');
      break;
    case 'long':
      parts.push('消息偏长');
      break;
    default:
      break;
  }

  switch (style.humor) {
    case 'heavy':
      parts.push('爱开玩笑');
      break;
    case 'none':
      parts.push('不太用幽默');
      break;
    default:
      break;
  }

  return parts.join('，');
}

/**
 * 构建语言互惠 prompt 块
 * @param {LinguisticStyle} style - 用户风格分析结果
 * @returns {string} prompt 文本
 */
function buildLinguisticMatchPrompt(style) {
  const candidate = getLinguisticToneCandidate(style);
  if (!candidate) return '';
  return `【语言风格匹配】${candidate.text}。`;
}

/**
 * 从最近的消息中提取风格上下文
 * @param {string} userText - 当前用户消息
 * @param {string[]} [recentMessages] - 最近的用户消息历史
 * @returns {{ style: LinguisticStyle, promptBlock: string }}
 */
function matchLinguisticStyle(userText, recentMessages = []) {
  // 如果有历史消息，使用历史分析（更稳定）
  const allMessages = [...recentMessages, userText].filter(Boolean);
  const style = allMessages.length >= 3
    ? analyzeUserStyleFromHistory(allMessages.slice(-5))
    : analyzeUserStyle(userText);

  const promptBlock = buildLinguisticMatchPrompt(style);

  return { style, promptBlock };
}

module.exports = {
  analyzeUserStyle,
  analyzeUserStyleFromHistory,
  matchLinguisticStyle,
  buildLinguisticMatchPrompt,
  getLinguisticToneCandidate,
  styleToToneDescription,
};
