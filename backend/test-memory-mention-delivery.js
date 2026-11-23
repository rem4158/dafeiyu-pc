// Isolated PC service. Observe the optional recorder from an independent
// SQLite connection, so an uncommitted event or message is detectable.
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startFixture } = require('./test-alignment-e2e');

async function main() {
  const previousData = process.env.DAFEIYU_DATA_DIR;
  const fixture = await startFixture();
  const media = require('./media');
  const memory = require('./electron/brain/memory');
  const mentions = require('./electron/brain/memory-mentions');
  const record = mentions.recordDeliveredMentions;
  const enrich = media.enrichMessages;
  const db = memory.initMemory();
  const observer = new DatabaseSync(path.join(fixture.data,'companion-memory.db'),{readOnly:true});
  const historySize = () => observer.prepare("SELECT COUNT(*) AS n FROM pc_messages WHERE role='bot'").get().n;
  const events = () => observer.prepare('SELECT COUNT(*) AS n FROM pc_events').get().n;
  const records = [];
  const api = fixture.api;
  const chat = (id,text) => api('POST','/chat',{session_id:'main',request_id:id,text});
  let resume;
  try {
    mentions.recordDeliveredMentions = (_,texts,opts) => {
      records.push({texts:[...texts],...opts,history:historySize(),events:events()});
    };
    const core = await chat('plain','我住在北京。请发条语音。');
    const parts = core.messages.flatMap(message => message.parts);
    assert.ok(parts.some(p => p.type==='record') && parts.some(p => p.type==='image'));
    const visible = [...new Set(parts.filter(p => p.type==='plain').map(p => p.text.trim()))];
    assert.equal(records.length,2,'ordinary delivery and one check for newly extracted facts');
    assert.deepEqual(records.map(r => r.texts),[visible,visible]);
    assert.equal(records[0].now,records[1].now,'extraction time cannot advance the cooldown');
    assert.ok(records[1].sourceMessageId > 0);
    assert.equal(records[0].history,core.messages.length,'callback sees the committed PC message');
    await chat('plain','我住在北京。请发条语音。');
    assert.equal(records.length,2,'replay is not a second delivery');

    let atMedia;
    const mediaReached = new Promise(resolve => {atMedia=resolve;});
    const barrier = new Promise(resolve => {resume=resolve;});
    media.enrichMessages = async (...args) => {atMedia(); await barrier; return enrich(...args);};
    const cancelled = chat('cancelled','这条应该在交付前取消。');
    await mediaReached;
    await api('POST','/sessions/main/stop',{});
    resume();
    assert.equal((await cancelled).cancelled,true);
    media.enrichMessages = enrich;
    assert.equal(records.length,2);

    await api('PUT','/settings',{memory:{enabled:false}});
    await chat('disabled','已关闭记忆。');
    assert.equal(records.length,2);
    await api('PUT','/settings',{memory:{enabled:true,autoExtract:false}});
    media.enrichMessages = async () => [{text:'蓝铃贴纸',parts:[{type:'image',filename:'蓝铃贴纸.png'}]}];
    await chat('image','请发表情。');
    assert.equal(records.length,2,'sticker metadata is not speech');
    media.enrichMessages = enrich;
    mentions.recordDeliveredMentions = () => {throw Error('simulated unavailable optional recorder');};
    assert.ok((await chat('optional','普通消息仍然可交付。')).messages.length);
    mentions.recordDeliveredMentions = (_,texts,opts) => records.push({texts,...opts,history:historySize(),events:events()});

    async function attemptProactive(requestId) {
      await api('POST','/companion/presence',{session_id:'main',chat_open:true,busy:false,typing:false,voice_active:false,quiet:false,
        reply_completed:{session_id:'main',request_id:requestId}});
      fixture.advance(180000);
      return fixture.backend.companion.tick();
    }
    const before = historySize();
    let outboxAttempts = 0;
    db.function('note_outbox_attempt',() => ++outboxAttempts);
    db.exec("CREATE TEMP TRIGGER fail_delivery BEFORE INSERT ON pc_events BEGIN SELECT note_outbox_attempt(); SELECT RAISE(ABORT,'event unavailable'); END");
    const failed = await attemptProactive('optional');
    assert.equal(failed.reason,'generation_failed');
    assert.equal(outboxAttempts,1,'the failed attempt reached the outbox insert');
    assert.equal(historySize(),before,'failed proactive event also rolls back its chat message');
    assert.equal(events(),0);
    assert.equal(records.length,2);
    db.exec('DROP TRIGGER fail_delivery');
    assert.equal((await fixture.backend.companion.tick()).sent,false,'the same failed delivery is not retried');
    await chat('new-opportunity','我再回一句。');
    assert.equal((await attemptProactive('new-opportunity')).sent,true);
    const delivered = (await api('GET','/events?after=0')).events[0];
    assert.deepEqual(records.at(-1).texts,delivered.messages.flatMap(m=>m.parts).filter(p=>p.type==='plain').map(p=>p.text));
    assert.equal(records.at(-1).events,1,'proactive callback sees the committed event');
    assert.equal(records.at(-1).history,historySize());
    console.log('memory-mention-delivery: PASS (visible plain parts, source-scoped extraction, replay, cancellation, disabled, recorder failure and atomic proactive outbox)');
  } finally {
    resume?.();
    mentions.recordDeliveredMentions=record;
    media.enrichMessages=enrich;
    observer.close();
    try {await fixture.close();} finally {fixture.cleanup();}
    if (previousData===undefined) delete process.env.DAFEIYU_DATA_DIR;
    else process.env.DAFEIYU_DATA_DIR=previousData;
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
