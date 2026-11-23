// Reuse model providers with cancellation, no window/account dependency, bounded lifetime.
const lifecycle = require('./cognition-lifecycle');
function messagesForRole(settings,messages) {
  // Never rewrite evidence/user messages just because they contain an old character name.
  return [...messages,{role:'system',content:`当前角色称呼是「${settings.characterName || '大肥鱼'}」，当前用户是「${settings.ownerName || '主人'}」。保留稳定人格与真实经历，不将起源故事误认为用户事实。`}];
}
function call(provider,settings,messages,options={}) {
  if (!lifecycle.active()) return Promise.reject(new Error('Cognition stopped'));
  const signal=options.signal ? AbortSignal.any([options.signal,lifecycle.signal()]):lifecycle.signal();
  return lifecycle.track(provider(settings,messagesForRole(settings,messages),{
    ...options,signal,timeoutMs:Math.min(options.timeoutMs || 30000,30000)}).catch(()=>{throw new Error(signal.aborted ? 'Cognition request cancelled' : 'Cognition model request failed');}));
}
module.exports={chatCloud:(s,m,o)=>call(require('./cloud').chatCloud,s,m,o),
  chatOllama:(s,m,o)=>call(require('./ollama').chatOllama,s,m,o)};
