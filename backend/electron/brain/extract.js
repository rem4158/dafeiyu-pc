/** @typedef {{ category: string, factKey: string, factValue: string, importance?: number, factType?: string }} ExtractedFact */
const { isResidenceKey, isResidenceFact } = require('./memory-residence');

const NAME_PATTERNS = [/^(?:我(?:的名字)?叫|(?:你)?(?:可以)?叫我|称呼我[为是]?|我的名字是)[：:\s]*([\u4e00-\u9fffA-Za-z0-9_·]{1,16})$/];

const presentLead = /^(?:(?:其实|对了|不过|但(?:是)?|而|现在|最近|如今|平时|一般|通常|个人来说|说起来)\s*)+/;
const otherOwner = /^我(?:的)?(?:朋友|同学|同事|家人|室友|邻居|老板|客户|对象|父母|爸|妈|母亲|父亲|哥|姐|弟|妹|儿子|女儿|孩子|男友|女友|男朋友|女朋友|老公|老婆|老师|学生|宠物)/;
const delegated = /^我(?:最近|刚才|打算|要|想|会|正在|刚)?(?:给|为|替|帮|陪|教|问|跟|和|想知道|听|猜|以为|怀疑|担心|推荐|发现|看到|看见|得知)/;
const ordinaryOwner = /^我(?!们)|^(?:你可以叫我|可以叫我|叫我|称呼我)/;
const request = /^(?:(?:能不能|能|能否|可不可以|可以|请|请问|麻烦|想请你|你|帮我|给我)\s*)*(?:根据|参考|推荐|介绍|解释|举例|翻译|提醒|回忆|告诉我|猜猜|猜你|帮我(?:想|挑|选)|记不记得|还记得|记得我)|^(?:给|帮|替|为)(?:我(?:的)?)?(?:朋友|同事|同学|家人|他|她)/;

const EVENT_PATTERNS = [
  /(?:帮我?)?记(?:一下|住)[：:\s，,]*([^，。！？\n]{2,80})/,
  /今天(?:是|发生了?|我)[：:\s，,]*([^，。！？\n]{2,60})/,
];

function cleanValue(raw) {
  return raw
    .trim()
    .replace(/[吧呢啊呀哦嘛了啦]+$/, '')
    .trim();
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const value = cleanValue(m[1]);
      if (value.length >= 1) return value;
    }
  }
  return null;
}

function isDirectMemoryStatement(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return !/如果|(?<!主)要是|假如|假设|举例|例子|比如|开玩笑|角色扮演|[?？]|你觉得|是不是|是否|好像|可能|也许|据说|他说|她说|别人说|我听说|(?:说|问|写道)[：:，,「“"]|不确定|记不记得|什么|哪(?:种|款|个|家|些|儿|里|一|座)|(?:叫|喝|吃|喜欢)啥|吗[。.!！\s]*$/.test(text)
    && !request.test(text.trim());
}

// A question can share a turn with an assertion. Keep quoted spans opaque,
// including their punctuation, so a sentence inside a quotation cannot become
// a new first-person source. Discard the rest of an unclosed quotation.
const quoteEnd = new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['"','"'],["'","'"],['《','》']]);
const openFrame = /(?:说|问|写道|said|wrote)[：:，,]\s*(?!\s*\0)|(?:示例|例子|example)[：:]|举(?:个)?例|比如|打个比方|角色扮演|假装|假设一下|开个玩笑/iu;
const disclaimer = /(?:刚才|前面|上面|以上|前一句|那句).{0,8}(?:玩笑|举例|示例|假设|编的)|(?:只是|纯属|开个?)玩笑|开玩笑的/u;
function directMemoryPassages(input) {
  const text = String(input || '').trim();
  const ends = [];
  let masked = '';
  for (let i=0; i<text.length; i++) {
    const ch=text[i];
    if ((ch==="'" || ch==='’') && /[a-z]/i.test(text[i-1] || '') && /[a-z]/i.test(text[i+1] || '')) {
      if (!ends.length) masked += ch;
      continue;
    }
    if (ends.length && ch === ends.at(-1)) { ends.pop(); continue; }
    if (quoteEnd.has(ch)) {
      if (!ends.length) masked += '\0';
      ends.push(quoteEnd.get(ch));
    } else if (!ends.length) masked += ch;
  }
  if (masked === text && !openFrame.test(text) && !disclaimer.test(text) && isDirectMemoryStatement(text)) return [text];

  const result = [];
  for (const paragraph of masked.split(/\n\s*\n/u)) {
    if (disclaimer.test(paragraph)) continue;
    for (const sentence of paragraph.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+|(?<=\.)(?=[\p{Script=Han}])/u)) {
      // An unquoted example or reported passage introduced with a colon can
      // span multiple sentences. Its end is unknown until the next paragraph.
      if (openFrame.test(sentence)) break;
      // A closed quotation may be followed by the speaker's own assertion.
      // A surrounding hypothetical still scopes both halves of the sentence.
      if (sentence.includes('\0') && /如果|要是|假如|假设|举例|比如|假装|角色扮演/u.test(sentence)) continue;
      // Switches of speaker/addressee are boundaries. Keep tag questions
      // ("我喜欢茶，对吗？") with the claim they qualify.
      for (const part of sentence.split(/[，,]\s*(?=你|您|请问|帮我|给我)|(?<=\0)[，,\s]*(?=(?:但(?:是)?|不过|而)?我)/u)) {
        const passage = part.trim();
        if (!passage.includes('\0') && isDirectMemoryStatement(passage)) result.push(passage);
      }
    }
  }
  return result;
}

// Keep the complete source clause while deciding who made a claim. An LLM
// can quote a substring that omits "我朋友" or "以前".
function personalClauses(text) {
  let previousWasSelf = false;
  return text.split(/[，,。.!！；;\n]/).map(s=>s.trim()).filter(Boolean).map(evidence => {
    let body = evidence.replace(presentLead,'');
    const inverted = /^(.{1,24}?)是我(?:的)?(.{1,8})$/.exec(body);
    if (inverted && (isResidenceKey(inverted[2]) || /^(?:名字|昵称|职业)$/.test(inverted[2])))
      body='我的'+inverted[2]+'是'+inverted[1];
    if (previousWasSelf && /^(?:但(?:是)?|不过|而|现在|如今)/.test(evidence) && !ordinaryOwner.test(body))
      body = '我'+body;
    const self = ordinaryOwner.test(body) && !otherOwner.test(body) && !delegated.test(body);
    previousWasSelf = self || /^(?:以前|过去|曾经)我/.test(evidence);
    return {body,evidence,self: self && !/以前|曾经|过去|原先|当时|曾喜欢|原来喜欢|以为|“|”|「|」/.test(evidence)};
  });
}

function preferenceOf(clause) {
  if (!clause.self) return null;
  const match = /^我(?:本人|自己)?(?:现在|平时|一般|通常|最近|一向|一直|已经|也|很|特别|最|比较)*(不再喜欢|不再爱|不喜欢|不爱|讨厌|喜欢|偏爱|爱好(?:是)?|爱)(喝|吃)?[：:\s]*(.{1,24})$/.exec(clause.body);
  if (!match) return null;
  const [,verb,action='',raw] = match;
  const value = cleanValue(raw);
  if (!value || /^(?:上了|过的)|(?:还是|或者|[：:“”「」])/.test(value)) return null;
  const retract = verb.startsWith('不再') || (verb==='不喜欢' && /已经不喜欢/.test(clause.body) && /了$/.test(raw));
  const negative = /^(?:讨厌|不)/.test(verb) && !retract;
  const fact = {category:'preference',factKey:negative?'不喜欢':'喜欢',factValue:value,importance:4,evidence:clause.evidence};
  if (retract) fact.operation='retractPreference';
  if (action) {
    fact.legacyValues=[action+value];
    fact.keywords=JSON.stringify(['@source-action:'+action]);
  }
  return fact;
}

function habitOf(clause) {
  if (!clause.self) return null;
  const match = /^我(?:平时|一般|通常|经常|每天|习惯)(?:都|会)?(喝|吃)(.{1,24})$/.exec(clause.body);
  if (!match) return null;
  const value = cleanValue(match[2]);
  return value ? {category:'habit',factKey:'常'+match[1]+'：'+value,factValue:value,importance:3,evidence:clause.evidence} : null;
}

// Bind a residence proposal to the place in the assertion. A sentence about
// commuting or moving can name both an old place and a destination.
function statedResidence(body) {
  const subjectless=body.replace(/^我(?:本人|自己)?(?:现在|目前|一直|长期|常年|刚刚|刚|已经|最近|如今)*/,'');
  const property=/^的?(.{1,8}?)(?:是|在)(.+)$/.exec(subjectless);
  if (property && (isResidenceKey(property[1]) || /^(?:家|住址|住所|现住址|居住地址)$/.test(property[1])))
    return property[2].replace(/[了啦]+$/,'').trim();
  const afterPlace=/^在(.{1,30}?)(?:居住|定居|生活)(?:了)?$/.exec(subjectless);
  if (afterPlace) return afterPlace[1].trim();
  const match = /^(?:从.{1,24}?)?(?:住(?:在)?|居住(?:在)?|生活在|常住(?:在)?|定居(?:在)?|家住(?:在)?|现居(?:在)?|搬(?:家)?(?:到|来|去)(?:了)?)(.+)$/.exec(subjectless);
  if (!match) return '';
  return match[1].split(/但是|不过|但|然后|还要|每天|也在|工作在|上班在|打算|准备|出差|旅游|办事/)[0]
    .replace(/(?:已经|有|快)?[零一二两三四五六七八九十百半\d]+(?:个?月|年)(?:多)?了?$/,'')
    .replace(/[了啦。！!]+$/,'').trim();
}

// An explicitly named city field can be saved even if the optional model
// extraction fails. A place merely mentioned during travel needs more evidence.
function declaredCity(clause) {
  const claim = /^我(?:的)?(.{1,8}?)(?:是|在)([\p{L}·]{2,20})$/u.exec(clause.body);
  if (!claim || !isResidenceKey(claim[1])) return null;
  const value = claim[2].replace(/[了啦]$/,'');
  if (/以前|不是|还没|附近|和|还是|或者|想去|出差|暂时|那边|这里|那里|不知道/.test(value)) return null;
  const fact = {category:'profile',factKey:'城市',factValue:value,importance:4,evidence:clause.evidence};
  return isResidenceFact(fact) ? fact : null;
}

function residenceSupports(fact,body) {
  const location = statedResidence(body);
  if (!location) return false;
  const value = fact.factValue;
  if (location===value) return true;
  // A written administrative boundary supports “深圳” in “广东省深圳市…”.
  // “北京路” alone does not establish that the user lives in Beijing.
  if (!isResidenceFact(fact)) return false;
  const city = value.replace(/市$/,'');
  return city.length>=2 && location.includes(city+'市');
}

function hasResidenceLabel(fact) {
  return (fact.category==='profile' || fact.category==='other') &&
    (isResidenceKey(fact.factKey) || /^(?:用户的?|我的?)?(?:住址|住所|现住址|居住地址|详细地址)$/.test(fact.factKey));
}

// For model proposals, check the person and present assertion before using
// a quoted value. A deterministic preference/withdrawal already supplies the
// canonical row, so an inconsistent model label must not create a second one.
function allowsModelFact(fact, evidence, clauses) {
  if (fact.category==='plan' || fact.category==='event') return true; // vetted by episode extraction
  const matches = clauses.filter(c => c.evidence.includes(fact.factValue) &&
    (c.evidence.includes(evidence) || evidence.includes(c.evidence)));
  if (matches.length!==1) return false;
  const c=matches[0];
  // The original model extractor also supports other languages. Apply the
  // Chinese attribution checks to Chinese claims; keep explicit English
  // self-statements and the source/evidence gate for other languages.
  if (!/[\u4e00-\u9fff]/.test(c.evidence)) {
    if (hasResidenceLabel(fact) && /\b(?:I|my)\b/i.test(c.evidence)) {
      const stated=/^(?:I (?:now |currently )?(?:live in|reside in|moved (?:from .+? )?to)|my (?:current )?(?:city|home|address) is)\s+(.+)$/i.exec(c.evidence);
      return Boolean(stated && stated[1].trim().toLowerCase()===fact.factValue.trim().toLowerCase());
    }
    if (/\b(?:I|my|me|you|your|we|he|she|their|friend)\b/i.test(c.evidence))
      return /^(?:I\b|my\s)/i.test(c.evidence) &&
        !/^my\s+(?:friend|partner|parent|mother|father|brother|sister|colleague)\b|\b(?:used to|wish|wonder|if|my friend|he|she)\b/i.test(c.evidence);
    return true;
  }
  if (!c.self) return fact.category==='relationship' && otherOwner.test(c.body);
  const observed=preferenceOf(c) || habitOf(c);
  if (observed) return !observed.operation && fact.category===observed.category &&
    fact.factKey===observed.factKey && fact.factValue===observed.factValue;
  const name=firstMatch(c.body,NAME_PATTERNS);
  if (name) return fact.category==='profile' && fact.factKey==='名字' && fact.factValue===name;
  if (fact.category==='preference') {
    if (/(?:他|她|朋友|同事|同学|家人|室友|别人|不再)/.test(c.body)) return false;
    const negative=/不喜欢|不爱|讨厌|最怕吃|忌口|不吃|不喝|不能吃|不能喝/;
    if (negative.test(c.body)!==negative.test(fact.factKey)) return false;
    return negative.test(c.body) || /偏好|口味|喜欢|钟爱|喜爱|青睐|首选|最爱|心头好|最中意/.test(c.body);
  }
  if (fact.category==='habit')
    return /(?:每天|每晚|每早|每逢|每周|每星期|平时|一般|通常|经常|总是|习惯|常常|从不|从来不)/.test(c.body);
  if (hasResidenceLabel(fact)) {
    return residenceSupports(fact,c.body);
  }
  if (fact.category==='profile') {
    if (/不是|并非|不再|没有|原来是/.test(c.body)) return false;
    if (/^(?:名字|姓名|昵称|称呼)$/.test(fact.factKey))
      return /^(?:我(?:本人|的名字|的昵称)?(?:叫|是)|叫我|(?:你)?可以叫我|称呼我)/.test(c.body);
  }
  return true;
}

function extractPassage(text) {
  /** @type {ExtractedFact[]} */
  const facts = [];

  for (const clause of personalClauses(text)) {
    if (!clause.self) continue;
    const name = firstMatch(clause.body,NAME_PATTERNS);
    if (name) facts.push({category:'profile',factKey:'名字',factValue:name,importance:5,evidence:clause.evidence});
    const city = declaredCity(clause);
    if (city) facts.push(city);
    const fact = preferenceOf(clause) || habitOf(clause);
    if (fact) facts.push(fact);
  }

  const eventBody = firstMatch(text, EVENT_PATTERNS);
  if (eventBody && eventBody.length >= 2) {
    facts.push({
      category: 'event',
      factKey: eventBody.slice(0, 24),
      factValue: eventBody,
      importance: 3,
      factType: 'fleeting',
    });
  }

  return facts.filter(fact => text.includes(fact.factValue)).map(fact => ({...fact,evidence:fact.evidence || text}));
}

function extractFromUserMessage(userText) {
  return {facts:directMemoryPassages(userText).flatMap(extractPassage)};
}

/**
 * 云端 API Key 已配置时可进行 LLM 记忆/摘要提取。
 * @param {object | null | undefined} settings
 */
function isCloudExtractAvailable(settings) {
  return Boolean(settings?.provider === 'ollama' ? settings.ollama?.model : settings?.cloud?.apiKey?.trim());
}

module.exports = { extractFromUserMessage, isCloudExtractAvailable, isDirectMemoryStatement, directMemoryPassages, personalClauses, allowsModelFact };
