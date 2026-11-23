// Interpret the user's own action and its status in one clause. The model can
// supply a topic, but cannot establish who acted or that a plan was carried out.
const { isDirectMemoryStatement } = require('./extract');
const { groundTemporalFact } = require('./memory-time');

const unsafeContext = /假设|如果|假如|万一|倘若|要是|打个比方|差点|差一点|听说|听见|听到|转述|梦见|梦到|[“”「」『』"《》]|有人说|提到过|据传|传闻|希望|但愿/;
const reporting = /看到|看见|得知|被告知|获悉|转告|告诉我|通知我|宣布|发现.{0,10}(?:他|她|小.{1,3})(?:已|刚|去|获)|看着.{0,12}(?:参加|完成)|(?:替|帮|给).{1,10}(?:拿到|收到|领到|获得|报名|提交)/;
const others = /(?:我(?:的)?(?:朋友|同事|同学|家人|爸|妈|表哥|表姐|哥哥|姐姐|弟弟|妹妹|孩子|儿子|女儿|室友|对象|男友|女友|老师|学生)(?:们)?(?!和我))|(?:他|她|别人|对方)(?:们)?(?:的|要|去|已|把|在|参加|完成)|(?:我(?:要|想|刚|已经)?(?:帮|替|陪|代替|提醒|安排|通知|劝|叫|让|听)[^，。]{1,12}(?:去|参加|面试|考试|完成|取消|改期))/;
const uncertain = /(?:没(?:有)?|还没|未能|未曾|不曾|并非|并未|不是|不能|不会|不想|不一定|不打算|没打算|好像|可能|大概|似乎|也许|暂定|差点|差一点|是否|据说|说不准|不知道|不确定|原本|本来|本打算|原定|原计划|听说|未完成)/;
const wish = /(?:希望|梦想|想要|想去|想参加|想做|要是|要不要|有机会|有空再|考虑|打算要不要)/;
const repeated = /每(?:天|年|周|月|星期|一次)|经常|一向|平时|通常/;
const thirdPersonPrefix = /^(?:(?:其实|刚才|刚刚|刚|对了|后来|最近|已经|终于|昨天|前天|今天|明天|今晚|昨晚|上周|下周|周末|这次|那次)\s*)*$/;
const dateCue = /(?:大?后天|明天|明早|明晚|今晚|今天|今早|下周|下星期|下个?(?:月|礼拜)|本周|周末|星期[一二三四五六日天]|月底|月末|[0-9一二三四五六七八九十]+月[0-9一二三四五六七八九十]+[日号]|\d{4}-\d{1,2}-\d{1,2})/;
const takePart = /(?:动身去|前往|去参加|去参与|去参观|参加|参与|参观|出席|去做|去看|去听|去学|去爬|去跑|打算去|计划去|准备去|要去|报名参加|完成|提交|交付|做完|写完|看完|读完|跑完|考完|上完|拍完|学完|修复|修好|做成|获得|拿到|领到|收养|整理|制作|修缮|结束)(?:了|过)?/g;
const terminal = /(?:完成了|完成过|(?:做|写|看|读|跑|考|上|拍|学|交|面|比|练|听|做)完(?:毕)?了?|已经完成|(?:参加|参与|参观|出席|去|提交|交付|收养|制作|修复|整理|获得|拿到|领到)了|(?:修好|做成)了|结束了|通过了|办完了|顺利结束|终于完成)/;
const cancel = /取消(?:了)?|不再参加|不去(?=.{0,20}了$)|不参加(?=.{0,20}了$)/;
const move = /(?:改期|延期|推迟|延后|提前)(?:了)?(?:到|至|在|为)?|改到|改在|改为/;
const speculativeChange = /(?:想|准备|计划|打算|可能|也许|希望|申请|要|如果|考虑|能不能|(?:明天|后天)(?:再)?)(?:先|再|去|把.{1,20})?(?:取消|改期|延期|改到|提前|推迟)/;
const commitment = /(?:约(?:定|好)了?|安排(?:好|了)|决定(?:了)?|已经报名|报了名|要去|要参加|将要|计划(?:去|参加|完成|做)|打算(?:去|参加|完成|做)|预约(?:了|好))/;
const initialTime = /^(?:(?:今天|明天|后天|明早|明晚|昨天|前天|刚才|现在|已经|之前|周末|昨天|下周[一二三四五六日天]?|下个星期[一二三四五六日天]?|这周[一二三四五六日天]?|下个月|[0-9一二三四五六七八九十]+月[0-9一二三四五六七八九十]+[日号])(?:的)?|(?:打算|决定|计划|要|将|准备|预约好了|预约了|约好了|安排好了|有一场|有个|有一项|有个))+/u;
const beforeFuture = /明天|明早|明晚|后天|下(?:个)?(?:周|星期|礼拜|月)|明年|将要|打算|计划|准备完成/;
const multiTopic = /以及|或者|或是|和|与|、|还有|同时|并且|然后|再去/;

// Redact identifying modifiers when detail fades. Keep the literal topic
// separate for matching specifics, e.g. two different interviews.
const eventKinds = /面试|笔试|考试|答辩|测验|比赛|竞赛|马拉松|体检|复诊|手术|就诊|会议|面谈|会谈|聚会|聚餐|约会|婚礼|演出|演唱会|音乐会|讲座|展会|展销会|画展|展览|培训|课程|旅行|旅游|出差|露营|登山|搬家|毕业|入职|离职|开学|交稿|验收|汇报|发布会|路演|研讨会|志愿活动|活动|工作坊|读书会|试镜|排练|彩排|报名|复试|初试|复习|作业|论文|证书|奖学金|报告|模型|原型|项目|作品/gu;
const abstractKinds = { 修复:'修理',修好:'修理',修缮:'修理',整理:'整理',制作:'制作',收养:'收养',获得:'领取',拿到:'领取',领到:'领取',
  提交:'提交',交付:'交付',写完:'写作',读完:'阅读',看完:'观看',参观:'参观',出席:'活动',参加:'活动',参与:'活动',去爬:'登山',去跑:'跑步' };

function cleanTopic(value) {
  const topic = String(value || '').trim()
    .replace(/^(?:(?:我(?:的)?|我们(?:的)?|刚刚|刚才|终于|已经|原来|刚|之前说的|说过的|上次说的|这次的?|那次的?|那(?:场|个|次)|这(?:场|个|次)|一(?:场|项|个|次|只|份|本|座|门)|计划中的|关于|把|将))+/u, '')
    .replace(/(?:已经|终于|刚才|刚刚|刚|现在|这次|也|确定|被|给|的|啦|了|啊|呀)+$/u,'').trim();
  if (topic.length < 2 || topic.length > 26 || multiTopic.test(topic) || dateCue.test(topic)) return '';
  if (/[，。？！；、:：“”「」\d@]|(?:我|其实|要去|打算|准备去|约好|说过|安排在|晚上|上午|下午|点钟|前往|终于|因为|所以|对于|能否|知道|怎么|已经|还是|好像|也许)/.test(topic)) return '';
  if (/^(?:在|从|给|帮|和|为|对|去|还|要|已经|谢谢|确定|下个)|(?:准备|结果|消息|通知|名单)$/.test(topic)) return '';
  return topic;
}

function sourceFacts(facts, clause) {
  return facts.filter(f => f && ['plan','event'].includes(f.category) && typeof f.evidence === 'string' &&
    typeof f.factValue === 'string' && f.factValue && f.evidence.includes(f.factValue) &&
    (clause.includes(f.evidence) || (f.evidence.includes(clause) && clause.includes(f.factValue))));
}

function topicFrom(fragment, hints) {
  const verbs = [...fragment.matchAll(takePart)];
  const last = verbs.at(-1);
  let tail = last ? fragment.slice(last.index + last[0].length) : fragment.replace(initialTime,'');
  if (/^(?:在|去).{2,16}做(?:体检|复诊|手术)$/.test(tail)) tail = tail.slice(tail.lastIndexOf('做')+1);
  if (/^(?:去|做|有|考)(?:面试|笔试|体检|手术|考试|出差|搬家|复诊|报告|答辩|汇报)$/.test(tail)) tail=tail.slice(1);
  const fromAction = cleanTopic(tail);
  if (fromAction) return { topic:fromAction, verb:last?.[0] || '' };
  // Accept a model-proposed topic only when it is the literal object of this
  // claim. A loosely related keyword or a location is not enough evidence.
  for (const hint of hints) {
    for (const word of [hint.factValue, hint.factKey]) {
      const exact = cleanTopic(word);
      if (exact && tail.trim().replace(/了$/,'').endsWith(exact)) return { topic:exact, verb:last?.[0] || '' };
    }
  }
  return null;
}

function broadTopic(topic, verb) {
  const kinds = [...topic.matchAll(eventKinds)];
  const tail = kinds.findLast(k => k.index + k[0].length === topic.length);
  if (tail) return tail[0];
  const action = verb.replace(/^(?:去)(?=参加|参与|参观)/,'').replace(/[了过]$/,'');
  if (abstractKinds[action]) return abstractKinds[action];
  // A short attested action can survive without its identifying object (e.g.
  // a particular contract name). Never copy an unknown proper noun as a gist.
  if (/^[\p{Script=Han}]{2,4}$/u.test(action) && !/^(?:完成|结束|已经|曾经|通过|交了|去看|去做)$/.test(action)) return action;
  return '一件事';
}

function broadKindsIn(text) {
  return [...new Set([...String(text || '').matchAll(eventKinds)].map(m=>m[0]))];
}

function personalMilestone(body) {
  // Keep a consequential outcome if the person explicitly said it. Receiving
  // a licence is not evidence of the type of examination taken to get it.
  if (/(?:拿到|领到|获得)了?(?:我的|人生第一本|第一本)?(?:驾照|驾驶证)(?:[了啦啊]|$)/.test(body)) {
    return {topic:body.includes('驾照')?'驾照':'驾驶证',kind:'驾照',gist:'拿到驾照'};
  }
  if (/(?:收到了?|拿到了?)[\p{Script=Han}A-Za-z]{0,16}(?:录取通知书|录取通知)(?:[了啦啊]|$)/u.test(body)) {
    return {topic:body.includes('录取通知书')?'录取通知书':'录取通知',kind:'录取通知',gist:'收到录取通知'};
  }
  const trip = body.match(/(?:^|终于|今天|昨天|刚刚)(第一次)?(独自|一个人)?(?:坐飞机|乘飞机|乘机|搭飞机)(?:去[\p{Script=Han}]{2,8})?了$/u);
  if (trip) return {topic:'乘机',kind:'乘机',gist:(trip[1] || '')+(trip[2]?'独自':'')+'乘机'};
  return null;
}

function modelTopic(hints, object, status) {
  // Only use semantic proposals anchored in the user's actual object phrase.
  const topics = hints.filter(h => h.episode?.status===status).map(h=>h.episode.topic)
    .filter(t => typeof t==='string' && t===cleanTopic(t) && object.includes(t));
  return topics.length && new Set(topics).size===1 ? topics[0] : '';
}

function proposedCompletion(body, hints) {
  // Open vocabulary when a provider proposes a grounded episode. Require a
  // first-person perfective construction and the specific object of that verb.
  if (/^(?:的|喜欢|讨厌)|错过|忘记|以为|本以为|听|好奇|想象|等着|怕|担心|盼着|要|还在|期待|准备|计划/.test(body)) return null;
  const topic = modelTopic(hints, body, 'completed');
  if (!topic) return null;
  const at = body.indexOf(topic);
  if (at !== body.lastIndexOf(topic)) return null;
  const prefix = body.slice(0,at);
  const past = prefix.match(/([\p{Script=Han}]{1,8})(?:了|过)(?:一[个只项份座门本枚次]|那(?:个|项)|这(?:个|项)|自己的|第一[个本枚])?$/u);
  if (!past || /(?:决定|约定|预约|报名|安排|取消|推迟|看过|听说|喜欢|讨厌)/.test(past[1])) return null;
  // Prefer a coarse common action over copying nearby names from the sentence.
  const action = /雕(?:刻|好|成)|装订|编织|缝制|绘制|测绘|清点|修复|修好了?|拼装|改装|试飞|交付|组装|制作|设计|部署|调试|验收|提交|翻译|收养|出版|发表/.exec(past[1])?.[0] || '';
  return { topic, verb:action };
}

function changeTopic(body, match, hints) {
  let before = body.slice(0,match.index).replace(/^.*(?:把|将)/u, '');
  // Clause-initial adverbs are not part of an appointment's identity.
  before = before.replace(/^(?:(?:今天|昨天|明天|刚才|已经|决定|这次|之前)(?:的)?)+/u,'');
  const fromBefore = topicFrom(before,hints);
  if (fromBefore) return fromBefore;
  return topicFrom(body.slice(match.index + match[0].length),hints);
}

function interpret(clause, inferred, sourceAt) {
  if (!clause || clause.length > 180 || reporting.test(clause) || uncertain.test(clause) || wish.test(clause) || repeated.test(clause)) return null;
  const ownerAt = clause.indexOf('我');
  const hasOwner = ownerAt >= 0 && thirdPersonPrefix.test(clause.slice(0,ownerAt));
  if (ownerAt >= 0 && !hasOwner) return null;
  if (/我的(?:公司|单位|学校|医生|客户|同事|猫|狗|球队|家人|团队|部门|组员)(?:已经|明天|昨天|刚|下周|打算|计划|取消|参加|完成|改期)/.test(clause)) return null;
  if (!hasOwner && /(?:的(?:朋友|同事)|朋友|同事|家人|爸爸|妈妈|他|她|[\p{Script=Han}]{1,8}的)/u.test(clause)) return null;
  const body = hasOwner ? clause.slice(ownerAt).replace(/^我(?:们)?(?:的)?/,'') : clause;
  const hints = sourceFacts(inferred,clause);
  const milestone = hasOwner && !beforeFuture.test(clause) && !/(?:差点|打算|准备|要|想|计划|盼着|等着)/.test(body) && personalMilestone(body);
  if (milestone) return {topic:milestone.topic,gist:milestone.gist,matchingGist:milestone.kind,status:'completed',evidence:clause,
    factValue:clause,expiresAt:null,importance:4,linkOnly:false};
  const moved = body.match(move), cancelled = body.match(cancel);
  let status, subject, expiresAt = null;
  if (moved || cancelled) {
    if ((moved && cancelled) || speculativeChange.test(clause)) return null;
    const match = moved || cancelled;
    subject = changeTopic(body,match,hints);
    status = moved ? 'rescheduled' : 'cancelled';
    if (moved) {
      const target = body.slice(match.index + match[0].length).trim();
      if (target) expiresAt = groundTemporalFact({category:'plan',factValue:target},target,sourceAt)?.expiresAt ?? null;
    }
  } else {
    const done = body.match(terminal);
    if (done && !beforeFuture.test(clause) && !/(?:准备|打算|计划|要|将在).*(?:完成|做完|考完|看完|写完|通过|结束)/.test(body)) {
      status = 'completed';
      const after = body.slice(done.index + done[0].length);
      subject = topicFrom(after,hints);
      const proposed = modelTopic(hints,after,'completed');
      if (!subject && proposed) subject = {topic:proposed,verb:done[0]};
      if (subject) subject.verb = done[0];
      else subject = topicFrom(body.slice(0,done.index),hints);
      if (!subject && /^(?:今天|刚刚|刚才|刚|终于|已经|总算)*面完(?:了)?$/.test(body)) {
        return {topic:'面试',gist:'面试',matchingGist:'面试',status,evidence:clause,factValue:clause,importance:3,expiresAt:null,linkOnly:true};
      }
    } else if (hasOwner && !done && (dateCue.test(clause) || commitment.test(body))) {
      subject = topicFrom(body,hints);
      status = 'planned';
      if (subject && !subject.verb && broadTopic(subject.topic,'')==='一件事' &&
        !(commitment.test(body) && modelTopic(hints,body,'planned'))) return null;
      if (subject) expiresAt = groundTemporalFact({category:'plan',factValue:subject.topic},clause,sourceAt)?.expiresAt ?? null;
      if (dateCue.test(clause) && (expiresAt == null || expiresAt <= sourceAt)) return null;
      if (!dateCue.test(clause) && !commitment.test(body)) return null;
    } else if (hasOwner && hints.length && !beforeFuture.test(clause) && /[了过][^，。]+$/.test(body)) {
      // Open vocabulary for an explicit first-person past action in a source-
      // backed event. The completion marker must immediately introduce its object.
      const past = body.match(/^(?:刚刚|刚才|刚|已经|终于|今天|昨天|总算)*([\p{Script=Han}]{1,5})了(.+)$/u);
      if (past && !/[要想听说懂知觉以梦]|讨厌|喜欢|看过|期待|错过|忘记|放弃|暂停|终止|推掉|拒绝|推迟|打算|准备|约定|报名|安排/.test(past[1])) {
        subject = topicFrom(past[2],hints.filter(f=>f.category==='event'));
        if (subject) subject.verb = past[1];
      }
      subject ??= proposedCompletion(body,hints);
      if (!subject || !hints.some(f=>f.category==='event' && f.evidence.includes(subject.topic))) return null;
      status='completed';
    }
  }
  if (!status || !subject || (!hasOwner && ![...subject.topic.matchAll(eventKinds)].length)) return null;
  if (!hasOwner && !body.replace(initialTime,'').startsWith(subject.topic)) return null;
  // A joint/comparative phrase must not update just the first or last of several projects.
  if (multiTopic.test(body)) return null;
  const ratings = hints.map(h=>h.importance).filter(n=>Number.isInteger(n) && n>=1 && n<=5);
  const importance = ratings.length ? Math.max(...ratings) : 3;
  const kind = broadTopic(subject.topic,subject.verb);
  const gist = status==='completed' && /通过了/.test(clause) && ['面试','笔试','考试','答辩','复试','初试','测验','验收'].includes(kind)
    ? '通过'+kind : kind;
  return { topic:subject.topic, gist, matchingGist:kind, status, evidence:clause,
    factValue:clause, expiresAt, importance, linkOnly:!hasOwner };
}

function extractEpisodeCandidates(userText, inferredFacts = [], sourceAt) {
  if (typeof userText !== 'string' || !Number.isFinite(sourceAt) || userText.trimStart().startsWith('【用户表情消息】')) return [];
  // A single quotation or role-play can span multiple sentences.
  if (unsafeContext.test(userText) || /(?:举例|例子|比如|角色扮演|开玩笑|他(?:们)?说|她(?:们)?说|有人说|别人说|故事里|假装)/.test(userText)) return [];
  const grounded = Array.isArray(inferredFacts) ? inferredFacts.filter(f=>typeof f?.evidence === 'string' && userText.includes(f.evidence)) : [];
  const out = [];
  for (const sentence of userText.split(/(?<=[。！？!?；;\n])/u)) {
    if (!isDirectMemoryStatement(sentence) || others.test(sentence)) continue;
    if (/(?:吗|么|是不是|对不对|行不行|能否|会不会)[。！\s]*$/.test(sentence)) continue;
    const correction = /^(?:更正(?:一下)?|纠正(?:一下)?|我(?:之前)?说错了)[：:，,\s]+/.exec(sentence.trim());
    const statement = correction ? sentence.trim().slice(correction[0].length) : sentence;
    // Direct correction of the user's own prior cancellation. The topic,
    // denial and confirmed participation must all be in this same sentence.
    const reversal = correction && /^(?:我的|我之前的)([^，,。！？]{2,20}?)(?:并)?没有取消[，,](?:我)?(?:昨天|今天|刚才)?(?:我)?(?:已经|确实|还是)?参加了[。！\s]*$/.exec(statement);
    if (reversal) {
      const topic = cleanTopic(reversal[1]);
      if (topic && broadTopic(topic,'') !== '一件事') {
        const exact = statement.trim().replace(/[。！]$/u,'');
        out.push({topic,gist:broadTopic(topic,''),matchingGist:broadTopic(topic,''),status:'completed',evidence:exact,factValue:exact,expiresAt:null,importance:3,linkOnly:true,correctsPrior:true});
      }
      continue;
    }
    const clauses = statement.split(/[。！!？?，,；;\n]/u).map(s=>s.trim()).filter(Boolean);
    for (const clause of clauses) {
      const item = interpret(clause, grounded, sourceAt);
      if (item) {
        if (correction && clauses.length===1) item.correctsPrior = true;
        out.push(item);
      }
    }
  }
  return out;
}

module.exports = { extractEpisodeCandidates, broadKindsIn };
