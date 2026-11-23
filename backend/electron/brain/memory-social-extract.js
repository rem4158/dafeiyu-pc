const { chatCloud } = require('./cloud');
const { chatOllama } = require('./ollama');

/**
 * @typedef {Object} ExtractedPerson
 * @property {string} displayName
 * @property {string} relationType — family | friend | colleague | other
 * @property {string[]} aliases
 * @property {string} notes
 */

/**
 * @param {string} userText
 * @param {string} assistantReply
 */
function buildPeopleExtractPrompt(userText, assistantReply) {
  return `从以下对话中提取用户提到的「人物」（真人，有名字或稳定称呼）。

规则：
- 只提取用户原话明确提到的真人关系；忽略假设、引用、玩笑和助手内容。每条附 evidence，必须逐字复制用户原话，name 或 aliases 必须出现在 evidence；notes 只能逐字引用证据，不推测。
- 不提取宠物、公司、物品为独立节点（例如「小明有只猫」→ 人物小明，notes 写「有一只猫」）
- 不提取助手/AI/莉莉安
- 没有关系信息时返回空数组 []

relationType 取值：family | friend | colleague | other

输出 JSON 数组，每项格式：
{"name":"显示名","relationType":"friend","aliases":["别名"],"notes":"用户原话中的补充","evidence":"用户原话中的连续片段"}

aliases 可选；notes 合并属性与近况，不要重复 name。

用户: ${userText}
助手信息不参与人物提取。`;
}

/**
 * @param {string} raw
 * @returns {unknown[]}
 */
function parseJsonArrayFromLlm(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const parsed = JSON.parse(arrayMatch[0]);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * @param {Record<string, unknown>} item
 * @returns {ExtractedPerson | null}
 */
function mapPersonItem(item) {
  const displayName = String(item.name || item.displayName || '').trim();
  if (!displayName) return null;

  const relationRaw = String(item.relationType || item.relation || 'other').trim().toLowerCase();
  const relationType = ['family', 'friend', 'colleague', 'other'].includes(relationRaw)
    ? relationRaw
    : 'other';

  /** @type {string[]} */
  let aliases = [];
  if (Array.isArray(item.aliases)) {
    aliases = item.aliases.map((a) => String(a).trim()).filter(Boolean);
  }

  const notes = String(item.notes || item.note || '').trim();

  return { displayName, relationType, aliases, notes };
}

/**
 * @param {string} userText
 * @param {string} assistantReply
 * @param {object} settings
 * @returns {Promise<{ people: ExtractedPerson[] }>}
 */
async function extractPeopleWithLLM(userText, assistantReply, settings) {
  try {
    const user = String(userText || '').trim();
    if (!user) return { people: [] };

    const assistant = String(assistantReply || '').trim();
    const prompt = buildPeopleExtractPrompt(user, assistant);
    const messages = [
      { role: 'system', content: '你是人物关系提取助手。只输出合法 JSON 数组，不要 markdown。' },
      { role: 'user', content: prompt },
    ];

    const complete = settings.provider === 'ollama' ? chatOllama : chatCloud;
    const raw = await complete(settings, messages, { temperature: 0.1, timeoutMs: 20000,
      usageContext: { purpose: 'memory_people' } });
    const items = parseJsonArrayFromLlm(raw);

    /** @type {ExtractedPerson[]} */
    const people = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const mapped = mapPersonItem(/** @type {Record<string, unknown>} */ (item));
      const evidence = String(item.evidence || '');
      if (mapped && evidence && user.includes(evidence) && ![settings.characterName,settings.ownerName,'莉莉安'].filter(Boolean).includes(mapped.displayName)) people.push({...mapped,evidence});
    }
    return { people };
  } catch {
    return { people: [], failed: true };
  }
}

/** 规则兜底：无 cloud 时从口语提取人物 */
function extractPeopleFromRules(userText) {
  const text = String(userText || '').trim();
  if (!text) return [];

  /** @type {ExtractedPerson[]} */
  const people = [];

  const familyMap = [
    [/我妈|我妈咪|母亲/, '妈妈', 'family'],
    [/我爸|父亲|爸爸/, '爸爸', 'family'],
    [/老公|丈夫/, '老公', 'family'],
    [/老婆|妻子/, '老婆', 'family'],
    [/男朋友/, '男朋友', 'family'],
    [/女朋友/, '女朋友', 'family'],
  ];

  for (const [re, name, rel] of familyMap) {
    const familyAliases = require('./memory-people').FAMILY_CANONICAL_ALIASES[name] || [name];
    const ownRelation = familyAliases.some(alias => text.includes(alias.startsWith('我') ? alias : '我' + alias) || text.includes('我的' + alias));
    if (re.test(text) && ownRelation) {
      people.push({ displayName: name, relationType: rel, aliases: [], notes: '' });
    }
  }

  const friendMatch = text.match(/(?:我(?:的)?朋友(?:叫|是)?)[：:\s]*([\u4e00-\u9fffA-Za-z0-9_·]{1,8})/);
  if (friendMatch?.[1]) {
    people.push({
      displayName: friendMatch[1].trim(),
      relationType: 'friend',
      aliases: [],
      notes: '',
    });
  }

  const catNote = text.match(/([\u4e00-\u9fffA-Za-z0-9_·]{1,8})有(?:一只|个)?猫/);
  if (catNote?.[1]) {
    people.push({
      displayName: catNote[1].trim(),
      relationType: 'other',
      aliases: [],
      notes: '有一只猫',
    });
  }

  return people;
}

module.exports = {
  extractPeopleWithLLM,
  extractPeopleFromRules,
};
