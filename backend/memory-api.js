// Authenticated service routes for traceable memory management. No model calls on reads.
const memory = require('./electron/brain/memory');
const audit = require('./electron/brain/memory-audit');
function id(value) { const n=Number(value); if(!Number.isSafeInteger(n)||n<1) throw new Error('Invalid id');return n; }
async function handle({method,path,body={},db}) {
  if(!path.startsWith('/memory')) return null;
  db=db || memory.initMemory();
  try {
    if(method==='GET' && path==='/memory') {
      const overview=memory.getMemoryOverview('main',100);
      const detail=audit.overview(db);
      const people=db.prepare(`SELECT p.*,m.content AS source_text FROM user_people p LEFT JOIN messages m ON m.id=p.source_message_id ORDER BY p.last_mentioned_at DESC LIMIT 200`).all();
      // This database belongs to the single local identity; new chats use UUID session IDs.
      const summaries=db.prepare(`SELECT id,session_id,start_message_id AS startMessageId,
        end_message_id AS endMessageId,summary,created_at AS createdAt
        FROM summaries ORDER BY created_at DESC,id DESC LIMIT 50`).all();
      return {status:200,body:{...overview,...detail,people,profile:memory.getUserProfile(),
        layers:{...overview.layers,summaries},summaries}};
    }
    let match=path.match(/^\/memory\/facts\/(\d+)$/);
    if(match && method==='PUT') {
      const result=audit.edit(db,id(match[1]),body);
      memory.refreshGroundedProfile();
      return {status:200,body:result};
    }
    if(match && method==='DELETE') {
      const result=audit.remove(db,id(match[1]));
      memory.refreshGroundedProfile();
      return {status:200,body:result};
    }
    match=path.match(/^\/memory\/revisions\/(\d+)\/undo$/);
    if(match && method==='POST') {
      const result=audit.undo(db,id(match[1]));
      memory.refreshGroundedProfile();
      return {status:200,body:result};
    }
    match=path.match(/^\/memory\/people\/(\d+)$/);
    if(match && (method==='PUT'||method==='DELETE')) return {status:200,body:audit.editPerson(db,id(match[1]),body,method==='DELETE')};
    match=path.match(/^\/memory\/entity-revisions\/(\d+)\/undo$/);
    if(match && method==='POST') return {status:200,body:audit.undoEntity(db,id(match[1]))};
    if(path==='/memory/profile/refresh' && method==='POST') {
      return {status:200,body:{profile:memory.refreshGroundedProfile()}};
    }
    return {status:404,body:{code:'not_found',error:'不支持的记忆操作'}};
  } catch(error) {
    // Provider messages and SQL errors never cross the local API boundary.
    return {status:409,body:{code:'memory_conflict',error:'记忆操作未完成，可能已被更新；请刷新后重试'}};
  }
}
module.exports={handle};
