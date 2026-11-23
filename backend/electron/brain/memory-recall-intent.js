// A small, local vocabulary for questions about personal facts. Unknown
// questions continue through normal recall; this module never reads history.
const { isResidenceKey, isResidenceFact } = require('./memory-residence');
const addressKey = /^(?:住址|现住址|居住地址|家庭地址|详细地址|门牌号)$/;
function fold(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,'').trim();
}

const identity = [
  { question:/我(?:的)?(?:工作地(?:点)?|工作城市|上班地点)|我(?:现在)?在哪(?:个|座)?(?:城市|地方)?(?:上班|工作)/,
    key:/^(?:工作地|工作地点|工作城市|上班地点)$/ },
  { question:/我(?:的)?(?:老家|家乡|籍贯)(?:在|是)?(?:哪|什么)/,
    key:/^(?:老家|家乡|籍贯)$/ },
  { question:/我(?:的)?(?:名字|姓名|昵称|称呼)|我(?:叫什么|叫啥|叫哪个名字)|(?:怎么|如何|该怎么)(?:称呼我|叫我)|(?:平时|一般|通常)怎么叫我/,
    key:/^(?:名字|姓名|昵称|称呼)$/ },
  { question:/我(?:家|的)?(?:的)?(?:详细地址|具体地址|居住地址|家庭地址|现住址|住址|门牌号)|我(?:家|住).{0,4}(?:哪条路|哪条街|几号楼|几号门|几单元)/,
    matches:(fact,key)=>addressKey.test(key) || (isResidenceKey(key) && !isResidenceFact(fact)) },
  { question:/我(?:现在|目前|平时)?(?:居住|住|定居|生活)(?:的城市是|在)?(?:哪|什么地方|什么城市)|我(?:的)?(?:现居地|居住地|常住地|住处|所在城市)|我(?:现在|目前)?在哪(?:个|座)?城市(?:生活|居住|定居)?|我家在(?:哪|什么地方)/,
    matches:isResidenceFact },
  { question:/我(?:的)?(?:职业|工作岗位|职位|做什么工作|是做什么的|做哪(?:一)?行|干哪(?:一)?行|从事什么|靠什么工作)|我(?:是|在|做的|干的)(?:什么职业|什么工作|哪(?:个|一)?行业)|我(?:平时|现在|目前)?(?:做|干)(?:的)?(?:是什么|什么)工作/,
    key:/^(?:职业|工作|工作岗位|职位|行业)$/ },
];

// Match a subject in the fact itself or an explicit classification from the
// extractor. The leaf groups stop a tea question from reopening every drink.
const groups = {
  tea:{ parent:'drink', query:/茶|乌龙|龙井|普洱|铁观音/, item:/茶|乌龙|龙井|普洱|铁观音|大红袍/ },
  coffee:{ parent:'drink', query:/咖啡|拿铁|美式咖啡|卡布奇诺/, item:/咖啡|拿铁|冷萃|卡布奇诺|馥芮白|(?:^|[:\s])美式(?:$|[\s:])/ },
  drink:{ query:/喝|饮料|饮品|解渴|口渴|点(?:一)?杯/, item:/饮品|饮料|饮用|喝|果汁|可乐|汽水|豆浆|牛奶|椰汁|气泡水|柠檬水|矿泉水|啤酒|葡萄酒|奶昔/ },
  food:{ query:/吃|餐|食物|饮食|饭|菜|忌口|口味|点外卖|点菜/, item:/食物|饮食|口味|忌口|吃|餐|饭|菜|火锅|米线|面条|面食|拉面|意面|披萨|寿司|饺子|馄饨|海鲜|香菜|辣椒|牛肉|羊肉|鸡肉|蛋糕|饼干|甜点|花生|巧克力|草莓|苹果|芒果/ },
  sport:{ parent:'hobby', query:/运动|锻炼|健身/, item:/运动|锻炼|健身|跑步|游泳|徒步|骑行|羽毛球|乒乓|篮球|网球|足球|攀岩|瑜伽/ },
  music:{ parent:'hobby', query:/音乐|歌曲|听歌|乐队|歌手/, item:/音乐|歌曲|听歌|乐队|歌手|摇滚|民谣|爵士|弹琴|钢琴|吉他/ },
  game:{ parent:'hobby', query:/游戏|打电玩/, item:/游戏|电玩|桌游|下棋/ },
  hobby:{ query:/爱好|兴趣|闲暇|业余|空闲|休闲|打发时间|有空.{0,5}(?:做|玩|干)/, item:/爱好|兴趣|业余|摄影|画画|绘画|山水画|油画|国画|水彩|陶艺|木工|阅读|看书|书法|园艺|编织/ },
};
const drinkObjects = /喝彩|乌龙院|茶杯|茶具|茶壶|茶几|茶馆|茶园|茶色|茶叶蛋|茶餐厅|咖啡杯|咖啡机|咖啡馆|咖啡店|咖啡色|(?:茶|咖啡).{0,3}(?:蛋糕|饼干|冰淇淋)/;
const negative = /不(?:太)?(?:喜欢|爱|喝|吃|能吃|能喝|碰)|讨厌|忌口|过敏|接受不了|不能接受|避开|避免/;
const relatives = /朋友|同学|同事|室友|家人|同桌|同伴|妈妈|爸爸|母亲|父亲|妹妹|姐姐|哥哥|弟弟|老公|老婆|丈夫|妻子|我妈|我爸|我姐|我妹|我哥|我弟/;
const otherSubject = /(?:他|她|对方|别人)(?:们|的|那次|那场|以前|曾经|之前|平时|一般|通常|最|比较|会|爱|喜欢|不爱|住|叫|喝|吃|想)|(?:给|替|帮|为)(?:他|她|别人|对方)/;
const knowledge = /(?:什么是|什么叫(?:做)?|的定义|是什么意思|区别|有何不同|不同之处|是怎么(?:做|泡|冲|制|来)|如何(?:制作|冲泡)|怎么(?:冲泡|制作)|怎么泡|百科|科普|介绍一下|介绍下|解释一下|翻译|造句|举(?:个|一个)例)/;
const memoryQuestion = /[?？]|哪|什么|啥|怎么|如何|吗|么|想知道|还记得|记不记得|推荐|建议|帮我(?:选|挑|点|决定)|帮.+(?:选|挑)|给我(?:选|挑|配)|按我.{0,8}(?:选|挑|点)|适合|有什么|来(?:一)?杯/;
const suggestion = /推荐|建议|(?:给我|帮我|按我.{0,6})(?:选|挑|点|配)|适合|该(?:点|吃|喝)|选哪|(?:喝|吃|点)点什么|来(?:一)?杯/;
const requestPosture = /(?:你(?:还|可|能|知|觉|猜|帮|记|建议|推荐|认为|觉得|说)|帮我|告诉我|想知道|请问)/;

function subjectsIn(text, field) {
  const matched = Object.keys(groups).filter(k => groups[k][field].test(text) &&
    !(drinkObjects.test(text) && (k==='tea' || k==='coffee' || k==='drink')));
  return new Set([...matched,...matched.map(k => groups[k].parent).filter(Boolean)]);
}

function factKeywords(raw) {
  if (typeof raw==='string') {
    try { raw=JSON.parse(raw); } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [];
}

function keywordSubjects(tags) {
  return new Set(tags.filter(t=>typeof t==='string' && !t.startsWith('@source-action:'))
    .flatMap(t => [...subjectsIn(fold(t),'item')]));
}

function external(allowPeople) {
  return {scope:'external',allowPeople,matchesFact:()=>false};
}

// For a new sourced preference, earlier rule versions sometimes stored the
// action in its value (“喝乌龙茶”). A bare animal, colour or hobby is ambiguous.
function legacyPreferenceValues(value) {
  if (typeof value!=='string') return [];
  const noun=fold(value);
  if (!/^[\p{Script=Han}a-z]{1,22}$/u.test(noun) || /^(?:不|我|你|他|她|想|经常|平时|喝|吃|喜欢)/.test(noun) ||
      /(?:喝|吃|味的|颜色|绘制|制作|制作的|收藏)/.test(noun)) return [];
  if (!drinkObjects.test(noun) && /(?:茶|乌龙|龙井|普洱|铁观音|大红袍|咖啡|拿铁|卡布奇诺|馥芮白|可乐|汽水|豆浆|牛奶|果汁|椰汁|柠檬水|气泡水|啤酒|葡萄酒|奶昔)$/.test(noun))
    return ['喝'+value];
  if (/(?:火锅|米线|炒饭|盖饭|面条|拉面|炒面|意面|披萨|寿司|馄饨|饺子|包子|蛋糕|饼干|冰淇淋|巧克力|香菜|花生)$/.test(noun))
    return ['吃'+value];
  return [];
}

function analyzeRecallIntent(userText) {
  const text = fold(userText);
  if (!text || !(memoryQuestion.test(text) || /^(?:请|帮我|给我)?(?:科普|介绍|解释|翻译)/.test(text))) return null;
  if (knowledge.test(text)) return external(false);
  const namedRecipient = /(?:给|替|为|帮)(?!我|咱|自己|你)[\p{Script=Han}]{1,5}(?:选|挑|买|点|推荐)/u;
  if (relatives.test(text) || otherSubject.test(text) || namedRecipient.test(text)) return external(true);
  if (/(?:怎么称呼你|你家在哪|你(?:自己|本人|平时|一般|通常|更|最|比较)?(?:的(?:口味|爱好|名字|家|职业)|爱(?:喝|吃|好|玩)|喜欢|讨厌|住在?|想喝|想吃|喝什么|吃什么|叫什么|做什么工作|做哪行))/.test(text))
    return external(false);
  // A plan or a past experience has its own evidence and detail/gist rules.
  if (/(?:那场|那次|上回|上次|参加|面试|考试|比赛|改期|取消|曾经|以前住|去过|喝过|吃过|曾住)/.test(text)) return null;

  const field = identity.find(f=>f.question.test(text));
  if (field) return {scope:'self',matchesFact(fact) {
    if (fact.category!=='profile' && fact.category!=='other') return false;
    const key=fold(fact.factKey??fact.fact_key).replace(/^(?:用户的?|我的?)/,'');
    return field.matches ? field.matches(fact,key) : field.key.test(key);
  }};

  const subjectClause = text.replace(/^(?:我想(?:问问?|知道)|我好奇|(?:你)?知道|请问)/,'');
  const namedSubject = /^(?:[小阿老][\p{Script=Han}]{1,3}|[\p{Script=Han}]{2,3})(?:平时|通常|一般|喜欢|爱喝|爱吃|住哪|住在|叫什么|做什么工作)/u;
  if (!/[我你咱]/.test(subjectClause) && namedSubject.test(subjectClause)) return external(true);
  const querySubjects = subjectsIn(text,'query');
  // Retain only the most specific groups requested.
  for (const name of [...querySubjects]) if (groups[name].parent) querySubjects.delete(groups[name].parent);
  const broadPreference = /我(?:平时|一般|通常|到底|都|最)?(?:喜欢什么|爱什么|不喜欢什么|讨厌什么|有什么偏好)[呢吗啊呀?。!]*$/.test(text);
  if (!querySubjects.size && !broadPreference) return null;
  const recommends = suggestion.test(text);
  if (!/我|咱/.test(subjectClause) && !recommends && !requestPosture.test(text)) return external(false);
  const asksNegative = negative.test(text);
  const explicitTarget = text.match(/(?:喜欢|偏爱|讨厌|爱喝|爱吃|常喝|常吃)([^，。?!]{1,30}?)(?:吗|(?<!什)么|对吗)[?。!]*$/)?.[1];
  const target = explicitTarget && !/哪|什么|啥/.test(explicitTarget) ? explicitTarget.replace(/^(?:喝|吃)/,'') : '';
  const yesNo = Boolean(target);
  return {
    scope:'self',
    matchesFact(fact) {
      if (fact.category!=='preference' && fact.category!=='habit') return false;
      if (!recommends && fact.category==='habit' && /喜欢|偏爱|讨厌/.test(text)) return false;
      const key=fold(fact.factKey??fact.fact_key), value=fold(fact.factValue??fact.fact_value);
      if (!value || relatives.test(key+value) || otherSubject.test(key+value)) return false;
      if (target && !value.includes(target) && !key.includes(target)) return false;
      if (!recommends && !yesNo && negative.test(key+value)!==asksNegative) return false;
      if (broadPreference && !querySubjects.size) return fact.category==='preference';
      const direct = subjectsIn(key+' '+value,'item');
      const keywords = factKeywords(fact.keywords);
      // The local extractor alone can emit this reserved single tag. “喝岚七”
      // is enough evidence for a drink even when the name is new to us.
      if (fact.category==='preference' && ['喜欢:','不喜欢:'].some(prefix=>key===prefix+value)) {
        if (keywords.includes('@source-action:喝')) direct.add('drink');
        if (keywords.includes('@source-action:吃')) direct.add('food');
      }
      // An old model tag may refine an established parent category (e.g.
      // “常喝” + “茶”). A tag alone cannot make a book into a beverage.
      let tags;
      for (const topic of querySubjects) {
        if (direct.has(topic)) return true;
        const parent = groups[topic].parent;
        if (parent && direct.has(parent) && ![...direct].some(t=>groups[t].parent===parent)) {
          tags ??= keywordSubjects(keywords);
          if (tags.has(topic)) return true;
        }
      }
      return false;
    },
  };
}

module.exports = { analyzeRecallIntent, legacyPreferenceValues };
