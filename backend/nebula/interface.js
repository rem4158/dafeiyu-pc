'use strict';
(() => {
  const get=id=>document.getElementById(id);
  const byLayer=new Map(skyLayers.map(l=>[l.key,l]));
  let nodes=[],index=new Map(),sources=new Map(),counts=new Map(),gistCount=0;
  let key=null,group=null,state='loading',limit=6,busy=false,latestDate='';
  let navigation=0,arrived=false;
  const scene=nebulaScene((id,layer)=>choose(id,layer));
  const search=get('search');
  const formatter=new Intl.NumberFormat('zh-CN');
  const make=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
  const makeButton=(text,cb,cls)=>{const b=make('button',text,cls);b.type='button';b.onclick=cb;return b;};
  for(const layer of skyLayers){
    const b=makeButton('',()=>choose(null,layer.key),'layer');b.dataset.key=layer.key;
    b.append(make('i',''),make('span',layer.name),make('b','—'));get('layers').append(b);
  }
  async function choose(id,layer,reset=false) {
    const ticket=++navigation;
    key=id;group=key?index.get(key)?.layer:layer||null;
    limit=6;arrived=false;
    get('universe').classList.toggle('in-region',byLayer.has(group));
    const flight=scene.focus(byLayer.has(group)?group:null,key,group==='date',reset);
    render();syncMotion();
    if(await flight&&ticket===navigation&&key){arrived=true;render();}
  }
  function back(){
    if(key){choose(null,group);return;}
    if(group){choose(null,null);return;}
    search.value='';showResults();
  }
  function render() {
    const oldFocus=document.activeElement;
    const n=arrived?index.get(key):null,layer=byLayer.get(group),live=state==='ready'||state==='empty';
    get('count').textContent=live?formatter.format(nodes.length):'—';
    get('status').textContent=({loading:'正在读取',ready:'本机记忆 · 只读',empty:'暂无可显示记忆',unavailable:'记忆库暂不可读',appearance:'外观预览'})[state];
    for(const b of get('layers').children){
      b.lastElementChild.textContent=live?formatter.format(counts.get(b.dataset.key)||0):'—';
      b.setAttribute('aria-pressed',String(group===b.dataset.key));
    }
    const detail=get('detail');detail.replaceChildren();detail.classList.toggle('reveal',Boolean(n));
    get('back').hidden=!group;
    get('back').textContent=key?'返回星域':'返回全景';
    get('hint').textContent=key?'Esc 返回星域':layer?'悬停查看标题 · 点击记忆星 · Esc 返回全景':'点击云团进入星域 · 拖动旋转 · 滚轮缩放';
    get('detail-heading').textContent=n?'记忆详情':group==='date'?'日期星':layer?'当前星区':'星云概览';
    if(n){
      detail.append(make('div',layer.name+' ／ '+n.type,'detail-meta'),make('h3',n.title));
      if(n.text && n.text!==n.title)detail.append(make('p',n.text));
      if(n.gist)detail.append(make('p','只记得这件事的大意。'));
      else if(n.at)detail.append(make('div','最近记录　'+new Date(n.at).toLocaleDateString('zh-CN'),'detail-meta'));
      const linked=(sources.get(n.source)||[]).filter(item=>item.key!==key);
      if(linked.length){detail.append(make('p','同一次发言留下的记忆'));
        for(const item of linked){
          const b=makeButton(item.title,()=>choose(item.key),'rel');
          b.dataset.record=item.key;detail.append(b);
        }}
    }else if(group==='date'){
      detail.append(make('h3',latestDate),make('p','这一天最近写入或更新的记忆。'));
    }else if(layer){
      detail.append(make('div',live?formatter.format(counts.get(group)||0):'—','detail-big'),make('h3',layer.name),make('p',layer.desc));
      if(live&&counts.get(group))detail.append(make('p','点一颗亮星，看看大肥鱼记得什么。'));
    }else{
      detail.append(make('h3','大肥鱼记得的事'));
      const summary={appearance:'当前展示星云外观。在大肥鱼的记忆设置中可查看本机记忆。',
        empty:'这里会随对话逐渐出现记忆。',unavailable:'读取未完成。请确认记忆库可用后刷新。',
        loading:'正在打开本地记忆库。',ready:'点一团星云，走进大肥鱼的记忆。'};
      detail.append(make('p',summary[state]));
      if(live){detail.append(make('div','只保留大意的经历　'+gistCount+' 条','detail-meta'));}
      if(latestDate)detail.append(makeButton('最近记录　'+latestDate,()=>choose(null,'date'),'rel'));
    }
    showResults();
    if(!oldFocus.isConnected&&oldFocus.dataset.record){
      const match=Array.from(document.querySelectorAll('button[data-record]')).find(b=>b.dataset.record===oldFocus.dataset.record);
      (match||get('back')).focus({preventScroll:true});
    }
  }
  function showResults(){
    const q=search.value.trim().toLocaleLowerCase(),results=get('results');results.replaceChildren();
    get('more').hidden=true;
    if(!q&&!group)return;
    const found=nodes.filter(n=>(!group||n.layer===group||(group==='date'&&n.date===latestDate))&&(!q||(n.title+' '+n.text).toLocaleLowerCase().includes(q)));
    for(const n of found.slice(0,limit)){
      const b=makeButton(n.title,()=>choose(n.key),'result');b.title=n.title;b.dataset.record=n.key;
      b.setAttribute('aria-pressed',String(n.key===key));results.append(b);
    }
    if(!found.length)results.append(make('small',q?'没有找到匹配的记忆。':'这个星区还没有可显示的记忆。'));
    get('more').hidden=found.length<=limit;
  }
  async function read(){
    if(busy)return;busy=true;get('refresh').disabled=true;
    let data;
    try{data=window.fishMemory?await window.fishMemory.read():{status:'appearance',nodes:[]};}
    catch{data={status:'unavailable',nodes:[]};}
    state=data.status;
    nodes=data.nodes.sort((a,b)=>(b.at||0)-(a.at||0)||a.key.localeCompare(b.key));
    for(const n of nodes)n.date=n.at?new Date(n.at).toLocaleDateString('zh-CN'):'';
    latestDate=nodes[0]?.date||'';
    index=new Map(nodes.map(n=>[n.key,n]));sources=new Map();counts=new Map();gistCount=0;
    for(const n of nodes){
      counts.set(n.layer,(counts.get(n.layer)||0)+1);if(n.gist)gistCount++;
      if(n.source){if(!sources.has(n.source))sources.set(n.source,[]);sources.get(n.source).push(n);}
    }
    if(!index.has(key))key=null;
    if(group==='date'&&!latestDate)group=null;
    const dateLabel=latestDate?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'}).format(nodes[0].at):'';
    scene.install(nodes,dateLabel,state==='appearance');
    busy=false;get('refresh').disabled=!window.fishMemory;choose(key,group);
  }
  function syncMotion(){
    const local=byLayer.has(group),pause=get('pause');
    pause.disabled=local;pause.textContent=local?'旋转已暂缓':scene.moving?'暂停旋转':'开始旋转';
    pause.setAttribute('aria-pressed',String(local||!scene.moving));
  }
  get('pause').onclick=()=>{scene.motion(!scene.moving);syncMotion();};
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',event=>{
    if(event.matches){scene.motion(false);syncMotion();}
  });
  get('back').onclick=back;
  get('reset').onclick=()=>{search.value='';choose(null,null,true);};
  get('plus').onclick=()=>scene.zoomBy(1.18);get('minus').onclick=()=>scene.zoomBy(1/1.18);
  get('refresh').onclick=read;get('more').onclick=()=>{limit+=10;showResults();};
  search.addEventListener('input',()=>{limit=6;showResults();});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();back();return;}
    if(document.activeElement===search)return;
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){scene.turn(e.key==='ArrowLeft'?-.09:.09,0);e.preventDefault();}
  });
  syncMotion();read();
})();
