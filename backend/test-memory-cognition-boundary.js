// Exercise production cognition, growth prompts and reviews with an isolated SQLite DB and in-process model.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
async function main() {
  const temp = path.resolve(__dirname, '../temp');
  fs.mkdirSync(temp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(temp, 'memory-cognition-boundary-'));
  process.env.DAFEIYU_DATA_DIR = dir;
  const secret = '旧原话标记';
  const config = { provider:'cloud', characterName:'念安测试', memory:{enabled:false,autoExtract:false,retentionDays:0} };
  const settings = require('./electron/brain/settings');
  const originalLoad = settings.loadSettings, originalFetch = global.fetch;
  settings.loadSettings = () => config;
  global.fetch = () => { throw Error('unexpected network'); };
  const memory = require('./electron/brain/memory');
  const db = memory.initMemory();
  const gateway = require('./electron/brain/digital-life-narrative-gateway');
  const crystal = require('./electron/brain/digital-life-crystallize');
  const reflect = require('./electron/brain/digital-life-metacognition');
  const milestone = require('./electron/brain/digital-life-milestones');
  const transport = require('./electron/brain/cognition-transport'), originalCloud = transport.chatCloud;
  const {createCompanionRuntime} = require('./companion-runtime');
  const runtime = createCompanionRuntime({ db, getSettings:()=>config, publishAssistant:()=>{} });
  const candidate = '我在学习如何更温柔地倾听，也愿意和你一起保持好奇心。';
  let calls = [], reject = true;
  transport.chatCloud = async (_, messages) => {
    const text = messages.map(m => m.content).join('\n');
    calls.push(text);
    if (text.includes('审核代理')) return JSON.stringify({ passed: !reject, reason:'fixture' });
    if (text.includes('输出纯JSON')) return JSON.stringify({selfInsight:'我愿意先倾听',dialogueHint:'我可以给对方多一点耐心'});
    return candidate;
  };
  try {
    const now = Date.now();
    const stateOnly = () => runtime.beforeChat({ userText:'聊聊近况', stateOnly:true });
    const initial = stateOnly();
    assert.match(initial, /^【当前情绪】[^\n]+\n【依恋状态】安全型$/);
    db.prepare("UPDATE attachment_state SET anxiety=0.8 WHERE user_id='default'").run();
    assert.match(stateOnly(), /^【当前情绪】[^\n]+\n【依恋状态】焦虑型$/);
    const oldNarrative = '我是一个温柔的AI伴侣，正在学习如何更好地理解和陪伴用户。' + secret + '。';
    db.prepare('UPDATE personality_narrative SET narrative_text=? WHERE id=1').run(oldNarrative);
    db.prepare('INSERT INTO emotion_events(trigger_detail,emotion_after_json,created_at) VALUES (?,?,?)')
      .run(secret, '{"empathy":0.8}', now);
    db.prepare('INSERT INTO relational_milestones(milestone_type,title,description,trigger_event,significance,created_at) VALUES(?,?,?,?,1,?)')
      .run('reunion', secret, secret, secret, now);
    db.prepare('INSERT INTO metacognition_reflections(reflection_text,self_insight,dialogue_hint,trigger_reason,created_at) VALUES(?,?,?,?,?)')
      .run(secret, secret, secret, 'conflict', now - 5 * 3600000);
    const ordinary = stateOnly();
    assert.match(ordinary, /^【当前情绪】[^\n]+\n【依恋状态】焦虑型$/);
    assert.ok(!ordinary.includes(secret));
    const before = runtime.beforeChat({userText:'聊聊近况'});
    assert.ok(!before.includes(secret));
    assert.match(before,/共情/); assert.match(before,/重逢/);
    assert.match(before,/先听清楚/);

    const reflection = await reflect.performMetacognitiveReflectionV2(db, {isConflict:true,
      text:secret, recentDialogue:secret, summary:secret, emotion:'empathy'});
    assert.equal(reflection.reflected, true);
    assert.ok(!stateOnly().includes('我可以给对方多一点耐心'));
    assert.match(runtime.beforeChat({userText:'你好'}), /我可以给对方多一点耐心/);
    milestone.submitMilestoneToGateway({milestone:{type:'reunion',title:secret,description:secret,triggerEvent:secret}});
    assert.ok(!JSON.stringify(gateway.snapshotPending()).includes(secret));
    // A queue persisted by an old release can contain an unsafe proposal as well as old evidence.
    gateway.restorePending([{source:'milestone', requestId:'old', reason:secret,
      evidence:secret, proposedNarrative:secret, priority:0.5, createdAt:now}]);
    assert.ok(!JSON.stringify(gateway.snapshotPending()).includes(secret));
    gateway.setGatewayRuntimeContext({db, llmClient:{available:true}, settings:config});
    const rejected = await gateway.flushQueue(db);
    assert.equal(rejected.accepted, 0);
    assert.equal(crystal.getCurrentNarrative(db).narrative_text, oldNarrative);
    assert.equal(calls.filter(s=>s.includes('审核代理')).length,3,'all gateway review gates run');
    assert.ok(calls.every(s => !s.includes(secret)));
    calls = []; reject = false;
    for (let i=0; i<3; i++) db.prepare('INSERT INTO drift_log(emotion_vector_json,interaction_quality,dialogue_summary,drift_date,created_at) VALUES(?,?,?,?,?)')
      .run('{"empathy":0.7}',0.8,secret,'2026-01-01',now);
    const result = await crystal.runCrystallization(db, {available:true}, config);
    assert.ok(result.success, result.reason);
    assert.equal(calls.filter(s=>s.includes('审核代理')).length,6,'both rounds of three-agent review ran');
    assert.ok(calls.some(s => s.includes('3 次互动')));
    assert.ok(calls.every(s => !s.includes(secret)), 'no legacy quotation reaches growth generation or review');
    assert.equal(crystal.getCurrentNarrative(db).narrative_text, candidate);
    assert.equal(db.prepare('SELECT narrative_text FROM personality_narrative WHERE id=1').get().narrative_text, oldNarrative);
    assert.equal(stateOnly(), ordinary + '\n【成长变化】' + candidate);
    const after = runtime.beforeChat({userText:'聊聊近况'});
    assert.ok(after.includes('【成长提示】'), 'state-only read preserves the pending full-prompt notice');
    assert.ok(!after.includes(secret)); assert.ok(after.includes(candidate), 'reviewed character growth remains visible');
    console.log('memory-cognition-boundary: PASS (emotion, relational state, reflection, restored queue, rejected and accepted reviews, preserved archive and new narrative)');
  } finally {
    await runtime.close(); gateway.resetRuntime(); memory.closeMemory();
    transport.chatCloud = originalCloud; settings.loadSettings = originalLoad; global.fetch = originalFetch;
    assert.ok(dir.startsWith(temp + path.sep));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
