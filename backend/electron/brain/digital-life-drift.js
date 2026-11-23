// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命系统 - 微漂移记录模块
 * 记录每次对话的情绪信号和证据，供结晶化使用
 */

const { getEmotionVector, inferEmotionFromText, getDominantEmotion } = require('./digital-life-emotion');

/**
 * 记录微漂移
 * @param {object} db - DatabaseSync 实例
 * @param {object} params
 * @param {string} params.userText - 用户消息
 * @param {string} params.reply - 助手回复
 * @param {string|null} params.emotion - 检测到的表情标签
 * @returns {object} 记录的漂移数据
 */
function recordMicroDrift(db, { userText, reply, emotion }) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // 获取当前情绪向量
  const emotionVector = getEmotionVector(db);

  // 推断本次对话的情绪信号
  const emotionDelta = inferEmotionFromText(reply, userText);

  // 评估交互质量（简单启发式）
  const interactionQuality = assessInteractionQuality(userText, reply);

  // 推断用户情绪
  const userEmotion = inferUserEmotion(userText);

  // 生成对话摘要（简短版）
  const dialogueSummary = summarizeDialogue(userText, reply);

  // 记录到 drift_log
  db.prepare(`
    INSERT INTO drift_log (
      emotion_vector_json,
      interaction_quality,
      user_emotion_json,
      dialogue_summary,
      dialogue_count,
      growth_stage,
      created_at,
      drift_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify(emotionDelta),
    interactionQuality,
    JSON.stringify(userEmotion),
    dialogueSummary,
    1, // 每次记录算一次对话
    getCurrentGrowthStage(db),
    now,
    today,
  );

  console.log('[DigitalLife] Micro-drift recorded:', {
    dominant: getDominantEmotion(emotionDelta).dimension,
    quality: interactionQuality.toFixed(2),
  });

  return {
    emotionDelta,
    interactionQuality,
    userEmotion,
    dialogueSummary,
  };
}

/**
 * 评估交互质量
 * @param {string} userText
 * @param {string} reply
 * @returns {number} 0-1
 */
function assessInteractionQuality(userText, reply) {
  let quality = 0.5;

  // 用户消息长度（越长越投入）
  const userLen = userText.length;
  if (userLen > 50) quality += 0.1;
  if (userLen > 100) quality += 0.1;

  // 回复长度
  const replyLen = reply.length;
  if (replyLen > 30) quality += 0.05;
  if (replyLen > 100) quality += 0.05;

  // 是否有情感词
  if (/喜欢|爱|开心|高兴|谢谢|辛苦|想你/.test(userText)) {
    quality += 0.1;
  }
  if (/难过|伤心|生气|烦|委屈/.test(userText)) {
    quality += 0.05; // 消极情绪分享也是深度交流
  }

  // 是否有问号（互动性）
  if (/[？?]/.test(userText)) {
    quality += 0.05;
  }

  return Math.max(0, Math.min(1, quality));
}

/**
 * 推断用户情绪
 * @param {string} userText
 * @returns {Record<string, number>}
 */
function inferUserEmotion(userText) {
  const emotion = {
    joy: 0, sadness: 0, anger: 0, curiosity: 0, empathy: 0,
    contentment: 0, excitement: 0, surprise: 0, trust: 0, warmth: 0,
  };

  if (/开心|高兴|哈哈|太好了|耶|棒|厉害|喜欢|爱|快乐|幸福/.test(userText)) {
    emotion.joy = 0.7;
  }
  if (/难过|伤心|哭|委屈|心疼|不开心|悲伤/.test(userText)) {
    emotion.sadness = 0.7;
  }
  if (/生气|讨厌|烦|气死|哼|愤怒/.test(userText)) {
    emotion.anger = 0.7;
  }
  if (/什么|为什么|怎么|如何|吗|呢|？|\?/.test(userText)) {
    emotion.curiosity = 0.6;
  }
  if (/理解|辛苦|心疼|抱抱|陪你|在乎|关心/.test(userText)) {
    emotion.empathy = 0.6;
  }

  // Step 2: 扩展5维
  if (/满足|舒服|惬意|安心|踏实/.test(userText)) {
    emotion.contentment = 0.6;
  }
  if (/太棒了|耶！|好耶|兴奋|激动/.test(userText)) {
    emotion.excitement = 0.7;
  }
  if (/诶|咦|哇|真的吗|不会吧/.test(userText)) {
    emotion.surprise = 0.6;
  }
  if (/相信|信任|当然|一定|肯定/.test(userText)) {
    emotion.trust = 0.6;
  }
  if (/温暖|温柔|贴心|暖心|感动/.test(userText)) {
    emotion.warmth = 0.6;
  }

  return emotion;
}

/**
 * 生成对话摘要
 * @param {string} userText
 * @param {string} reply
 * @returns {string}
 */
function summarizeDialogue(userText, reply) {
  // 截取前100字符作为摘要
  const userPart = userText.length > 50 ? userText.slice(0, 50) + '...' : userText;
  const replyPart = reply.length > 50 ? reply.slice(0, 50) + '...' : reply;
  return `用户: ${userPart} | 回复: ${replyPart}`;
}

/**
 * 获取当前成长阶段
 * @param {object} db
 * @returns {string}
 */
function getCurrentGrowthStage(db) {
  // 从 personality_core 的创建时间推算
  const core = db.prepare(`SELECT created_at FROM personality_core WHERE id = 1`).get();
  if (!core) return 'newborn';

  const daysSinceCreation = (Date.now() - core.created_at) / (1000 * 60 * 60 * 24);

  if (daysSinceCreation <= 7) return 'newborn';
  if (daysSinceCreation <= 37) return 'child';
  if (daysSinceCreation <= 127) return 'teen';
  return 'adult';
}

/**
 * 获取漂移统计
 * @param {object} db
 * @param {number} days - 统计天数
 * @returns {object}
 */
function getDriftStats(db, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const totalDrifts = db.prepare(`
    SELECT COUNT(*) as count FROM drift_log WHERE created_at >= ?
  `).get(cutoff)?.count || 0;

  const avgQuality = db.prepare(`
    SELECT AVG(interaction_quality) as avg FROM drift_log WHERE created_at >= ?
  `).get(cutoff)?.avg || 0;

  // 按日期分组统计
  const dailyCounts = db.prepare(`
    SELECT drift_date, COUNT(*) as count
    FROM drift_log
    WHERE created_at >= ?
    GROUP BY drift_date
    ORDER BY drift_date
  `).all(cutoff);

  // 汇总情绪信号
  const drifts = db.prepare(`
    SELECT emotion_vector_json FROM drift_log WHERE created_at >= ?
  `).all(cutoff);

  const emotionSum = {
    joy: 0, sadness: 0, anger: 0, curiosity: 0, empathy: 0,
    contentment: 0, excitement: 0, surprise: 0, trust: 0, warmth: 0,
  };
  let emotionCount = 0;
  for (const drift of drifts) {
    try {
      const vec = JSON.parse(drift.emotion_vector_json);
      for (const [k, v] of Object.entries(vec)) {
        emotionSum[k] = (emotionSum[k] || 0) + v;
      }
      emotionCount++;
    } catch {}
  }

  const emotionAvg = {};
  if (emotionCount > 0) {
    for (const [k, v] of Object.entries(emotionSum)) {
      emotionAvg[k] = v / emotionCount;
    }
  }

  return {
    totalDrifts,
    avgQuality,
    dailyCounts,
    emotionAverage: emotionAvg,
    days,
  };
}

/**
 * 获取最近的漂移记录
 * @param {object} db
 * @param {number} limit
 * @returns {Array}
 */
function getRecentDrifts(db, limit = 20) {
  return db.prepare(`
    SELECT
      id,
      emotion_vector_json,
      interaction_quality,
      user_emotion_json,
      dialogue_summary,
      growth_stage,
      created_at,
      drift_date
    FROM drift_log
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    ...row,
    emotion_vector: tryParseJson(row.emotion_vector_json),
    user_emotion: tryParseJson(row.user_emotion_json),
  }));
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

module.exports = {
  recordMicroDrift,
  getDriftStats,
  getRecentDrifts,
  getCurrentGrowthStage,
};
