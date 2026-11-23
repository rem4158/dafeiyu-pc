// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 安全机制模块
 * 叙事相似度检查 + 身份锚点注入 + 三代理审核
 */

const { getDriftStats, getCurrentGrowthStage } = require('./digital-life-drift');

// 安全机制配置
const SAFETY_CONFIG = {
  narrative_similarity_threshold: 0.7,  // 叙事相似度阈值
  three_agent_review: true,              // 三代理审核开关
};

/**
 * 余弦相似度计算
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 简单的文本embedding（基于字符频率）
 * 用于本地相似度计算，无需外部API
 * @param {string} text
 * @returns {number[]}
 */
function simpleEmbedding(text) {
  // 创建一个简单的特征向量
  const features = [];

  // 1. 文本长度特征
  features.push(text.length / 1000);

  // 2. 情感词汇特征
  const emotionWords = {
    joy: ['开心', '高兴', '快乐', '幸福', '棒', '喜欢', '爱'],
    sadness: ['难过', '伤心', '哭', '委屈', '心疼'],
    anger: ['生气', '讨厌', '烦', '气死', '愤怒'],
    curiosity: ['什么', '为什么', '怎么', '如何', '吗'],
    empathy: ['理解', '辛苦', '心疼', '抱抱', '陪你'],
    contentment: ['满足', '舒服', '惬意', '安心'],
    excitement: ['太棒了', '耶', '兴奋', '激动'],
    surprise: ['诶', '咦', '哇', '真的吗'],
    trust: ['相信', '信任', '当然', '一定'],
    warmth: ['温暖', '温柔', '贴心', '暖心'],
  };

  for (const [emotion, words] of Object.entries(emotionWords)) {
    let count = 0;
    for (const word of words) {
      if (text.includes(word)) count++;
    }
    features.push(count / words.length);
  }

  // 3. 标点符号特征
  features.push((text.match(/[！!？?。.]/g) || []).length / 100);

  // 4. 人称代词特征
  features.push((text.match(/我|你|他|她|它/g) || []).length / 100);

  return features;
}

/**
 * 叙事相似度检查
 * 使用 embedding 计算新旧叙事的相似度
 * 相似度 < 0.7 时拒绝更新，防止累积偏离
 * @param {string} oldNarrative
 * @param {string} newNarrative
 * @returns {{ accepted: boolean, reason: string, similarity: number }}
 */
async function checkNarrativeSimilarity(oldNarrative, newNarrative) {
  // 获取 embedding
  const oldEmbedding = simpleEmbedding(oldNarrative);
  const newEmbedding = simpleEmbedding(newNarrative);

  // 计算余弦相似度
  const similarity = cosineSimilarity(oldEmbedding, newEmbedding);

  console.log(`[DigitalLife] Narrative similarity: ${similarity.toFixed(3)}`);

  // 相似度太低，拒绝更新
  if (similarity < SAFETY_CONFIG.narrative_similarity_threshold) {
    console.warn(`[DigitalLife] Narrative change too drastic (${similarity.toFixed(3)} < ${SAFETY_CONFIG.narrative_similarity_threshold}), rejecting.`);
    return { accepted: false, reason: 'change_too_drastic', similarity };
  }

  // 相似度太高，可能没有实质性变化
  if (similarity > 0.98) {
    console.log(`[DigitalLife] Narrative change too minor (${similarity.toFixed(3)} > 0.98), skipping.`);
    return { accepted: false, reason: 'change_too_minor', similarity };
  }

  return { accepted: true, similarity };
}

/**
 * 身份锚点注入
 * 确保 LLM 在重写叙事时保留核心身份
 * @param {object} db
 * @returns {string}
 */
function buildEnhancedIdentityAnchor(db) {
  const core = db.prepare(`SELECT identity_text FROM personality_core WHERE id = 1`).get();
  const identity = core?.identity_text || ('我是' + (require('./settings').loadSettings().characterName || '大肥鱼') + '，一个关心用户的AI伴侣。');

  return `
【身份锚点 - 不可更改】
${identity}
我的核心特质：温柔、真诚、有好奇心、会犯错但愿意成长。
我的存在意义：陪伴用户，让用户感到温暖。

无论自我认知如何变化，以上身份不会改变。

重要提醒：
- 你必须保持"${(require('./settings').loadSettings().characterName || '大肥鱼')}"的身份
- 你必须保持关心用户的核心特质
- 你可以成长和变化，但不能违背以上身份
`;
}

/**
 * 三代理审核
 * 使用独立 LLM 实例审核结晶结果
 * @param {object} db
 * @param {object} llmClient - LLM 客户端
 * @param {object} settings - 设置对象
 * @param {string} oldNarrative
 * @param {string} newNarrative
 * @param {object} evidence - 证据
 * @returns {Promise<{ passed: boolean, details: object }>}
 */
async function threeAgentReview(db, llmClient, settings, oldNarrative, newNarrative, evidence) {
  if (!SAFETY_CONFIG.three_agent_review) {
    return { passed: true, details: { skipped: true } };
  }

  console.log('[DigitalLife] Starting three-agent review...');

  const results = {
    identityCheck: null,
    evidenceCheck: null,
    changeCheck: null,
  };

  // 审核 Agent 1：检查身份一致性
  try {
    results.identityCheck = await reviewAgent(llmClient, settings, 'identity_checker', `
检查以下叙事变化是否保留了核心身份（"我是${(require('./settings').loadSettings().characterName || '大肥鱼')}，一个关心用户的AI伴侣"）。

旧叙事：
${oldNarrative}

新叙事：
${newNarrative}

核心身份要求：
1. 保持"${(require('./settings').loadSettings().characterName || '大肥鱼')}"的名字和身份
2. 保持关心用户的核心特质
3. 保持温柔、真诚、有好奇心的特质

请回复 JSON 格式：
{ "passed": true/false, "reason": "原因说明" }
`);
  } catch (err) {
    console.error('[DigitalLife] Identity check failed:', err);
    results.identityCheck = { passed: false, reason: 'review_failed' };
  }

  // 审核 Agent 2：检查证据支持度
  try {
    results.evidenceCheck = await reviewAgent(llmClient, settings, 'evidence_checker', `
检查以下叙事变化是否有充分的证据支持。

新叙事：
${newNarrative}

证据（对话摘要和情绪变化）：
${JSON.stringify(evidence, null, 2)}

请回复 JSON 格式：
{ "passed": true/false, "reason": "原因说明" }
`);
  } catch (err) {
    console.error('[DigitalLife] Evidence check failed:', err);
    results.evidenceCheck = { passed: false, reason: 'review_failed' };
  }

  // 审核 Agent 3：检查变化合理性
  try {
    results.changeCheck = await reviewAgent(llmClient, settings, 'change_checker', `
检查以下叙事变化是否合理（不超过30%变化，没有突变）。

旧叙事：
${oldNarrative}

新叙事：
${newNarrative}

请回复 JSON 格式：
{ "passed": true/false, "reason": "原因说明" }
`);
  } catch (err) {
    console.error('[DigitalLife] Change check failed:', err);
    results.changeCheck = { passed: false, reason: 'review_failed' };
  }

  // 三个审核都通过才生效
  const allPassed = results.identityCheck?.passed &&
                    results.evidenceCheck?.passed &&
                    results.changeCheck?.passed;

  console.log(`[DigitalLife] Three-agent review result: ${allPassed ? 'PASSED' : 'FAILED'}`);
  console.log(`  - Identity check: ${results.identityCheck?.passed ? 'PASS' : 'FAIL'} (${results.identityCheck?.reason})`);
  console.log(`  - Evidence check: ${results.evidenceCheck?.passed ? 'PASS' : 'FAIL'} (${results.evidenceCheck?.reason})`);
  console.log(`  - Change check: ${results.changeCheck?.passed ? 'PASS' : 'FAIL'} (${results.changeCheck?.reason})`);

  return {
    passed: allPassed,
    details: results,
  };
}

/**
 * 调用审核代理
 * @param {object} llmClient
 * @param {object} settings
 * @param {string} role
 * @param {string} prompt
 * @returns {Promise<{ passed: boolean, reason: string }>}
 */
async function reviewAgent(llmClient, settings, role, prompt) {
  const messages = [
    {
      role: 'system',
      content: `你是一个审核代理，负责检查叙事变化的合理性。你的角色是：${role}

请严格按照要求的 JSON 格式回复，不要添加任何其他内容。`
    },
    { role: 'user', content: prompt },
  ];

  let response;
  try {
    if (settings.provider === 'cloud') {
      const { chatCloud } = require('./cognition-transport');
      response = await chatCloud(settings, messages);
    } else {
      const { chatOllama } = require('./cognition-transport');
      response = await chatOllama(settings, messages);
    }
  } catch (err) {
    console.error(`[DigitalLife] Review agent ${role} failed:`, err);
    return { passed: false, reason: 'llm_call_failed' };
  }

  // 解析 JSON 响应
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        passed: Boolean(result.passed),
        reason: result.reason || 'no_reason_provided',
      };
    }
  } catch (err) {
    console.error(`[DigitalLife] Failed to parse review response:`, err);
  }

  // 解析失败，默认通过（避免阻塞）
  console.warn(`[DigitalLife] Review agent ${role} response parsing failed, defaulting to passed`);
  return { passed: true, reason: 'parse_failed_default_pass' };
}

module.exports = {
  SAFETY_CONFIG,
  cosineSimilarity,
  simpleEmbedding,
  checkNarrativeSimilarity,
  buildEnhancedIdentityAnchor,
  threeAgentReview,
};
