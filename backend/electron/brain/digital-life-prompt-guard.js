// Adapted from the retained Nianan cognition modules for the local PC runtime.
const { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate } = require('./cognition-lifecycle');
/**
 * 数字生命 prompt 护栏：事实优先、话题感知、语气 hint 限量
 */

const FACT_GROUNDING_BLOCK = `【回复约束】以上情绪/内驱力/表达倾向提示仅调节语气与亲密度。尊重用户原话和已有记忆，不猜测用户未提及的行为、能力或经历。确实需要知道某件用户的事才能接着聊时，再自然问一句。`;

const TAKEOUT_PATTERN = /外卖|美团|饿了么|配送|叫外卖|订外卖|外带|打包带走|外卖到了|外卖来了|点(?:了|个|一份|一碗)(?:外卖|餐)/;
const SELF_COOKING_PATTERN = /自己做|下厨|炒菜|煮饭|厨艺|亲手做|做了.{0,8}(?:菜|饭|面|汤|吃的)/;

/**
 * @param {string} userText
 * @param {string[]} [recentUserMessages]
 */
function detectPromptTopicGuards(userText = '', recentUserMessages = []) {
  const combined = [userText, ...(recentUserMessages || [])].join('\n');
  const isTakeout = TAKEOUT_PATTERN.test(combined);
  const isSelfCooking = SELF_COOKING_PATTERN.test(combined);
  const takeoutNotCooking = isTakeout && !isSelfCooking;

  let topicHint = '';
  if (takeoutNotCooking) {
    topicHint = '【话题注意】用户是点外卖或外食，不要夸厨艺或假设用户自己做饭；可聊口味、哪家店、是否送到等。';
  }

  return {
    isTakeout: takeoutNotCooking,
    isSelfCooking,
    suppressCompetencePraise: takeoutNotCooking,
    topicHint,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function softenTonePhrase(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/^语气更加/g, '若合适，语气可更加')
    .replace(/^语气/g, '若合适，语气可')
    .replace(/现在很想/g, '或许想')
    .replace(/很想/g, '或许想')
    .replace(/可以多/g, '可适当')
    .replace(/可以多问/g, '可适当多问')
    .replace(/请用(.+?)的语气/g, '可参考$1的语气')
    .replace(/表现出/g, '可略表现出')
    .replace(/多用/g, '可适当用')
    .replace(/深入回应/g, '若合适可回应')
    .replace(/可以更/g, '可稍')
    .replace(/更活泼一些/g, '稍活泼一些')
    .replace(/更热情主动一些/g, '稍热情一些')
    .replace(/更温柔依赖一些/g, '稍温柔一些')
    .replace(/积极主动/g, '自然一些');
}

/**
 * @param {{ text: string, priority: number }[]} candidates
 * @param {number} [maxCount=2]
 * @returns {string[]}
 */
function selectTopToneHints(candidates, maxCount = 2) {
  return candidates
    .filter((c) => c.text && c.priority > 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxCount)
    .map((c) => softenTonePhrase(c.text));
}

/**
 * @param {Record<string, number>} emotionVector
 * @returns {number}
 */
function getEmotionTonePriority(emotionVector) {
  const max = Math.max(...Object.values(emotionVector || {}), 0);
  if (max > 0.7) return max * 12;
  if (max > 0.4) return max * 8;
  return 0;
}

module.exports = {
  FACT_GROUNDING_BLOCK,
  detectPromptTopicGuards,
  softenTonePhrase,
  selectTopToneHints,
  getEmotionTonePriority,
};
