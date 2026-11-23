'use strict';
const skyLayers = [
  {key:'working',name:'工作记忆',color:'#91b6ff',rgb:[123,151,244],pos:[-.89,-.01,.16],desc:'最近 24 小时仍有依据的 PC 发言。'},
  {key:'semantic',name:'语义记忆',color:'#80dcf2',rgb:[95,192,232],pos:[-.16,-.52,-.23],desc:'关于你的事实、偏好、习惯和人物。'},
  {key:'episode',name:'情景记忆',color:'#efa4ce',rgb:[224,119,177],pos:[-.24,.53,.29],desc:'聊过的经历，以及后来发生的变化。'},
  {key:'teaching',name:'交互教导',color:'#f0bd88',rgb:[235,163,95],pos:[.80,.14,-.11],desc:'你明确教过大肥鱼的回应方式。'}
];
function randomFrom(key) {
  let seed=2166136261;
  for(const c of String(key)) seed=Math.imul(seed^c.charCodeAt(0),16777619);
  return ()=>{seed=(seed+0x6d2b79f5)|0;let n=Math.imul(seed^(seed>>>15),1|seed);n^=n+Math.imul(n^(n>>>7),61|n);return ((n^(n>>>14))>>>0)/4294967296;};
}
function nebulaScene(onPick) {
  const sky=document.querySelector('#sky'),ctx=sky.getContext('2d');
  const map=document.querySelector('#map'),mapCtx=map.getContext('2d');
  const captions=document.querySelector('#captions');
  const fullTurn=2*Math.PI,rand=randomFrom('deepfish-orbits-v1');
  const normal=r=>(r()+r()+r()+r()-2);
  const medium=matchMedia('(prefers-reduced-motion: reduce)');
  let moving=!medium.matches,time=0,last=0,frame=0,drag=null;
  const home={x:0,y:0,z:0,yaw:-.11,pitch:.06,zoom:1};
  for(const layer of skyLayers) home[layer.key]=0;
  let camera={...home},overviewCamera=null,regionCamera=null,flight=null,route=0;
  const bases=new Map(),regionsOnScreen=[],cloudFootprints=[],mapRegions=[];
  const tooltip=document.querySelector('#star-title');
  let hovered=null,pointer=null;
  let width=0,height=0,scale=1,offsetY=0,offsetX=0,skyMid=0,selected=null,layerKey=null,hit=[];
  let nodes=[],linked=new Set(),sourceNodes=new Map(),byKey=new Map(),depthByLayer=new Map();
  let latestLabel='',dateScreen=null,dateSelected=false,overviewOnly=true;
  const bands=[],haze=[],sprites=[],background=[],labels=[];
  function sprite(rgb,cloud=false) {
    const c=document.createElement('canvas');c.width=c.height=cloud?128:24;
    const a=c.getContext('2d'),half=c.width/2;
    const g=a.createRadialGradient(half,half,0,half,half,half);
    for(const [r,alpha] of (cloud?[[0,.44],[.19,.32],[.47,.16],[.76,.045],[1,0]]:[[0,1],[.15,.97],[.35,.48],[.61,.11],[1,0]]))
      g.addColorStop(r,'rgba('+rgb.join(',')+','+alpha+')');
    a.fillStyle=g;a.fillRect(0,0,c.width,c.height);return c;
  }
  const rimColors=[[155,206,246],[186,173,245],[106,198,219],[217,203,238],[248,221,192]];
  const rimSprites=rimColors.map(rgb=>sprite(rgb));
  for(let i=0;i<170;i++)background.push([rand(),rand(),.35+rand()*.75,.15+rand()*.42]);
  // Fine strands within differently tilted rings make their near and far sides legible.
  for(const [ring,params] of [[.82,.35,.28,.52],[1.04,-.36,-.15,1.16],[1.27,.26,-.30,.62],[1.45,-.12,.32,-.82],[1.66,-.26,-.19,.93]].entries()){
    const [radius,slope,elevation,turn]=params;
    const strip=[];
    for(let i=0;i<1160;i++){
      const knot=Math.floor(rand()*6);
      const angle=i%3===0 ? fullTurn*(knot+.31*ring)/6+normal(rand)*.091 : rand()*fullTurn;
      const strand=i%4,ridge=(1+Math.sin(angle*3+ring))*.5;
      const spread=.008+.041*ridge**2;
      const radiusAt=radius+.020*Math.sin(angle*4+strand)+normal(rand)*spread+.009*strand;
      const x=radiusAt*Math.cos(angle),z=radiusAt*Math.sin(angle);
      strip.push({x:x*Math.cos(turn)-z*Math.sin(turn),z:x*Math.sin(turn)+z*Math.cos(turn),
        y:x*slope+z*elevation+.030*Math.sin(angle*3+ring)+normal(rand)*spread,
        size:.70+Math.pow(rand(),3)*1.9,light:.43+.56*rand(),phase:angle*4+rand(),sprite:rimSprites[(ring+(rand()<.22?1:0))%5]});
    }
    bands.push(strip);
  }
  for(const [i,layer] of skyLayers.entries()){
    const r=randomFrom(layer.key),mist=sprite(layer.rgb,true),glitter=sprite(layer.rgb);
    const [cx,cy,cz]=layer.pos,tilt=[.34,-.48,.36,-.19][i];
    const knots=Array.from({length:7},()=>[normal(r)*.23,normal(r)*.12,normal(r)*.13]);
    for(let j=0;j<70;j++){
      const center=knots[j%knots.length],u=center[0]+normal(r)*.062,v=center[1]+normal(r)*.044;
      haze.push({x:cx+u,y:cy+v+u*tilt,z:cz+center[2],size:.065+r()*.15,
        sprite:mist,layer:layer.key,light:.12+r()*.28,tilt});
    }
    for(let j=0;j<340;j++){
      const u=normal(r)*.18,v=normal(r)*.09;
      sprites.push({x:cx+u,y:cy+v+u*tilt,z:cz+.14*normal(r),size:.45+r()**4*1.5,
        sprite:glitter,layer:layer.key,light:.22+r()*.57,phase:r()*fullTurn});
    }
    const label=document.createElement('span');label.className='caption';label.dataset.key=layer.key;
    label.append(document.createElement('i'),document.createTextNode(layer.name));captions.append(label);labels.push(label);
  }
  function install(data,dateLabel,appearance) {
    latestLabel=dateLabel;overviewOnly=appearance;depthByLayer=new Map();
    sourceNodes=new Map();
    nodes=data.map(item=>{
      const layer=skyLayers.find(l=>l.key===item.layer),r=randomFrom(item.key);
      const u=normal(r)*.26,v=normal(r)*.15;
      const marker={item,layer,x:layer.pos[0]+u,y:layer.pos[1]+v+.21*u,z:layer.pos[2]+.21*normal(r)};
      depthByLayer.set(item.layer,(depthByLayer.get(item.layer)||0)+1);
      if(item.source){if(!sourceNodes.has(item.source))sourceNodes.set(item.source,[]);sourceNodes.get(item.source).push(marker);}
      return marker;
    });
    // Spread the same stars into a readable local view. Use record IDs so date
    // sorting and a round trip through the inspector do not reshuffle them.
    for(const layer of skyLayers){
      const members=nodes.filter(n=>n.layer===layer).sort((a,b)=>a.item.key.localeCompare(b.item.key));
      members.forEach((n,i)=>{
        const angle=i*Math.PI*(3-Math.sqrt(5))+.38;
        const radius=members.length===1 ? 0 : Math.sqrt((i+.45)/members.length);
        n.u=.325*radius*Math.cos(angle);
        n.v=.229*radius*Math.sin(angle)-.12*n.u;
        n.depth=radius*(n.z-layer.pos[2])*.33;
      });
    }
    byKey=new Map(nodes.map(n=>[n.item.key,n]));request();
  }
  function selectStar(id){
    selected=id;
    linked=new Set((sourceNodes.get(byKey.get(id)?.item.source)||[]).map(n=>n.item.key));
  }
  function travel(target,duration){
    if(flight){flight.finish(false);flight=null;}
    if(medium.matches||Object.keys(target).every(k=>Math.abs(camera[k]-target[k])<.00001)){
      camera={...target};request();return Promise.resolve(true);
    }
    const next={from:{...camera},target,duration,start:performance.now()};
    next.arrival=new Promise(resolve=>{next.finish=resolve;});
    flight=next;request();return next.arrival;
  }
  function advance(stamp){
    if(!flight)return;
    const {from,target,start,duration,finish}=flight;
    const t=medium.matches?1:Math.max(0,Math.min(1,(stamp-start)/duration));
    const eased=t*t*(3-2*t);
    for(const k of Object.keys(target))camera[k]=from[k]+(target[k]-from[k])*eased;
    if(t===1){camera={...target};flight=null;finish(true);}
  }
  function regionTarget(layer){
    const [x,y,z]=layer.pos;
    const horizontal=x*Math.cos(camera.yaw)+z*Math.sin(camera.yaw);
    const yaw=camera.yaw-horizontal*.20,pitch=camera.pitch*.78;
    bases.set(layer.key,{cy:Math.cos(yaw),sy:Math.sin(yaw),cp:Math.cos(pitch),sp:Math.sin(pitch)});
    return {...home,x,y,z,yaw,pitch,zoom:2.8,[layer.key]:1};
  }
  function localPoint(n){
    const b=bases.get(n.layer.key),[x,y,z]=n.layer.pos;
    const forward=n.depth*b.cp-n.v*b.sp;
    return [x+n.u*b.cy-forward*b.sy,y+n.v*b.cp+n.depth*b.sp,z+n.u*b.sy+forward*b.cy];
  }
  async function focus(layer,id,onDate=false,reset=false){
    const ticket=++route;
    dateSelected=onDate;pointer=hovered=null;sky.classList.remove('pickable');
    if(!layer){
      layerKey=null;selectStar(null);
      const arrived=await travel(reset?home:overviewCamera||camera,780);
      if(ticket===route&&arrived)overviewCamera=regionCamera=null;
      return arrived;
    }
    const entry=skyLayers.find(l=>l.key===layer);
    if(layer!==layerKey){
      if(!overviewCamera)overviewCamera={...camera};
      layerKey=layer;selectStar(null);
      regionCamera=regionTarget(entry);
      if(!await travel(regionCamera,800)||ticket!==route)return false;
    }else if(!selected&&flight){
      // A result selected during entry still arrives through its region.
      if(!await flight.arrival||ticket!==route)return false;
    }
    if(!id){
      if(!selected)return true;
      selectStar(null);return travel(regionCamera,520);
    }
    const n=byKey.get(id);
    if(!n)return false;
    if(!selected)regionCamera={...camera};
    const [x,y,z]=localPoint(n);
    selectStar(id);
    return travel({...regionCamera,x,y,z,zoom:regionCamera.zoom*1.23},470);
  }
  function fit(c) {
    const d=Math.min(devicePixelRatio||1,2);
    c.width=Math.max(1,Math.round(c.clientWidth*d));c.height=Math.max(1,Math.round(c.clientHeight*d));
    c.getContext('2d').setTransform(d,0,0,d,0,0);
  }
  let localScale=1;
  function resize(){
    fit(sky);fit(map);width=sky.clientWidth;height=sky.clientHeight;
    offsetY=sky.offsetTop;offsetX=sky.offsetLeft;skyMid=height*(width<720 ? .47 : .50);
    scale=Math.min(width*(width<720 ? .36 : .33),height*.45);
    const pane=document.querySelector('.navigation');
    const clearWidth=matchMedia('(max-width:720px)').matches ? width : width-2*(pane.offsetLeft+pane.offsetWidth);
    localScale=Math.min(scale,Math.max(64,clearWidth*.43));request();
  }
  function request(){if(!frame&&!document.hidden)frame=requestAnimationFrame(render);}
  function render(stamp){
    frame=0;
    const dt=last?Math.min(.06,(stamp-last)/1000):0;last=stamp;
    advance(stamp);
    if(moving&&!drag&&!flight&&!layerKey){time+=dt;camera.yaw+=dt*.033;}
    const {yaw,pitch,zoom}=camera;
    const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
    const near=skyLayers.reduce((sum,l)=>sum+camera[l.key],0);
    const unit=scale+(localScale-scale)*near;
    function project(x,y,z){
      x-=camera.x;y-=camera.y;z-=camera.z;
      const h=x*cy+z*sy,forward=z*cy-x*sy,depth=forward*cp+y*sp;
      const k=3.9/(3.9-depth);
      return [width*.5+h*k*unit*zoom,skyMid+(y*cp-forward*sp)*k*unit*zoom,k,depth];
    }
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.clearRect(0,0,width,height);
    ctx.fillStyle='#b4cbea';
    for(const [x,y,r,a] of background){ctx.globalAlpha=a;ctx.fillRect(x*width,y*height,r,r);}
    ctx.globalCompositeOperation='lighter';
    function cloudLight(layer){
      const count=depthByLayer.get(layer)||0;
      return overviewOnly ? .95 : Math.min(1.25,.34+Math.log1p(count)*.24);
    }
    function paintDot(dot,p,opacity) {
      if(p[0]<-8||p[0]>width+8||p[1]<-8||p[1]>height+8)return;
      const size=Math.max(1,dot.size*p[2]*(width>720?2.65:2.15)*Math.sqrt(zoom));
      ctx.globalAlpha=Math.min(1,opacity*p[2]);ctx.drawImage(dot.sprite,p[0]-size/2,p[1]-size/2,size,size);
    }
    for(const strip of bands)for(const dot of strip){
      const p=project(dot.x,dot.y,dot.z);
      paintDot(dot,p,dot.light*(.86+.14*Math.sin(time*.55+dot.phase))*(1-.76*near));
    }
    cloudFootprints.length=0;
    for(const puff of haze){
      const p=project(puff.x,puff.y,puff.z),r=puff.size*unit*p[2]*zoom;
      if(!layerKey)cloudFootprints.push({x:p[0],y:p[1],radius:r*.75,layer:puff.layer});
      ctx.globalAlpha=puff.light*cloudLight(puff.layer)*(1-.94*near+.47*camera[puff.layer]);
      ctx.save();ctx.translate(p[0],p[1]);ctx.rotate(puff.tilt+.14*sy);
      ctx.drawImage(puff.sprite,-r,-r*.67,r*2,r*1.34);ctx.restore();
    }
    for(const dot of sprites)paintDot(dot,project(dot.x,dot.y,dot.z),dot.light*cloudLight(dot.layer)*(1-.97*near+.52*camera[dot.layer]));
    dateScreen=null;
    if(latestLabel&&near<.99){
      const p=project(.025,.15,.25),r=Math.max(12,Math.min(26,scale*.054*zoom));dateScreen=p;
      ctx.globalAlpha=1-near;
      ctx.drawImage(rimSprites[4],p[0]-r,p[1]-r,r*2,r*2);
      ctx.strokeStyle='#ffe3a5';ctx.lineWidth=1;ctx.beginPath();
      ctx.moveTo(p[0]-r*.48,p[1]);ctx.lineTo(p[0]+r*.48,p[1]);ctx.moveTo(p[0],p[1]-r*.63);ctx.lineTo(p[0],p[1]+r*.63);ctx.stroke();
      ctx.font='12px "Microsoft YaHei UI",sans-serif';ctx.textAlign='center';ctx.fillStyle='#ffe0a2';ctx.fillText(latestLabel,p[0],p[1]+r+7);
      if(dateSelected){ctx.beginPath();ctx.arc(p[0],p[1],r*.75,0,fullTurn);ctx.stroke();}
    }
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
    hit=[];
    for(const n of nodes){
      const weight=camera[n.layer.key];
      if(near-weight>.99)continue;
      let x=n.x,y=n.y,z=n.z;
      if(weight>0){const local=localPoint(n);x+=(local[0]-x)*weight;y+=(local[1]-y)*weight;z+=(local[2]-z)*weight;}
      const p=project(x,y,z);n.screen=p;
      if(p[0]>=0&&p[0]<width&&p[1]>=0&&p[1]<height)hit.push(n);
    }
    const active=byKey.get(selected);
    if(active?.screen){ctx.lineWidth=1;ctx.strokeStyle='#afc8dc80';for(const n of hit){
      if(n!==active&&linked.has(n.item.key)){ctx.beginPath();ctx.moveTo(active.screen[0],active.screen[1]);ctx.lineTo(n.screen[0],n.screen[1]);ctx.stroke();}
    }}
    for(const n of hit){
      const weight=camera[n.layer.key];
      const [x,y,k]=n.screen,r=Math.max(1.2,((n.item.importance||2)*.30+1.1)*k*Math.sqrt(zoom)+1.3*weight);
      const dim=(active&&!linked.has(n.item.key)&&n!==active)||(dateSelected&&n.item.date!==nodes[0]?.item.date);
      const brightness=n.item.gist ? .52 : (dim ? .53 : .96);
      ctx.globalAlpha=brightness*(1-near+weight);
      if(weight>.01){
        const halo=(n===active?39:n===hovered?31:18)*weight;
        ctx.drawImage(rimSprites[0],x-halo,y-halo,halo*2,halo*2);
      }
      ctx.fillStyle=n.layer.color;ctx.beginPath();ctx.arc(x,y,r+1.1,0,fullTurn);ctx.fill();
      ctx.fillStyle='#effaff';ctx.beginPath();ctx.arc(x,y,r*.65,0,fullTurn);ctx.fill();
      if(n===active||n===hovered){ctx.globalAlpha=.9;ctx.strokeStyle=n.layer.color;ctx.beginPath();ctx.arc(x,y,r+(n===active?10:6),0,fullTurn);ctx.stroke();}
    }
    ctx.globalAlpha=1;
    regionsOnScreen.length=0;
    for(const [i,l] of skyLayers.entries()){
      const p=project(...l.pos),el=labels[i],weight=camera[l.key];
      const labelY=p[1]+scale*.09-weight*(scale*.09+unit*.80);
      el.style.left=(p[0]+offsetX)+'px';el.style.top=(labelY+offsetY)+'px';
      el.style.opacity=String((1-near+weight)*(selected?1-.9*weight:1));
      regionsOnScreen.push({layer:l,x:p[0],y:p[1],labelY,rx:Math.max(24,scale*p[2]*zoom*.28),ry:Math.max(17,scale*p[2]*zoom*.17)});
    }
    const target=pointer&&!flight&&!drag?pickAt(pointer):null;
    sky.classList.toggle('pickable',Boolean(target));
    const nextHover=target?.node||null;
    if(hovered!==nextHover){hovered=nextHover;request();}
    const titled=hovered||(!flight&&active);
    tooltip.hidden=!titled;
    if(titled){
      if(tooltip.textContent!==titled.item.title)tooltip.textContent=titled.item.title;
      const [x,y]=titled.screen,half=tooltip.offsetWidth/2+5;
      tooltip.style.left=(offsetX+Math.max(half,Math.min(width-half,x)))+'px';
      tooltip.style.top=(offsetY+(y<45?y+21:y-tooltip.offsetHeight-18))+'px';
    }else if(tooltip.textContent)tooltip.textContent='';
    drawMap(cy,sy);
    if(flight||(moving&&!drag&&!layerKey))request();
  }
  function drawMap(cy,sy){
    mapRegions.length=0;
    const w=map.clientWidth,h=map.clientHeight;if(!w||!h)return;
    mapCtx.clearRect(0,0,w,h);mapCtx.strokeStyle='#9ab8dc22';mapCtx.lineWidth=1;
    mapCtx.beginPath();mapCtx.ellipse(w*.5,h*.51,w*.43,h*.36,0,0,fullTurn);mapCtx.stroke();
    for(const [i,l] of skyLayers.entries()){
      const x=w*(.5+(l.pos[0]*cy+l.pos[2]*sy)*.35),y=h*(.49+l.pos[1]*.53);
      mapRegions.push({layer:l.key,x,y});
      const r=randomFrom(i);mapCtx.fillStyle=l.color;mapCtx.globalAlpha=layerKey&&layerKey!==l.key ? .35 : .85;
      for(let k=0;k<41;k++){mapCtx.beginPath();mapCtx.arc(x+normal(r)*8,y+normal(r)*5,.5+r(),0,fullTurn);mapCtx.fill();}
    }
    mapCtx.globalAlpha=1;
  }
  function mapRegionAt(e){
    const rect=map.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
    let nearest=null,distance=18;
    for(const region of mapRegions){
      const d=Math.hypot(x-region.x,y-region.y);
      if(d<distance){nearest=region.layer;distance=d;}
    }
    return nearest;
  }
  map.addEventListener('pointermove',e=>map.classList.toggle('pickable',Boolean(mapRegionAt(e))));
  map.addEventListener('click',e=>{const region=mapRegionAt(e);if(region)onPick(null,region);});
  function pickAt({x,y,touch}){
    if(!layerKey){
      if(dateScreen&&Math.hypot(dateScreen[0]-x,dateScreen[1]-y)<(touch?18:13))return {layer:'date'};
      let nearest=null,best=1;
      for(const zone of regionsOnScreen){
        if(Math.abs(x-zone.x)<40&&y>=zone.labelY-3&&y<=zone.labelY+19)return {layer:zone.layer.key};
        const distance=((x-zone.x)/zone.rx)**2+((y-zone.y)/zone.ry)**2;
        if(distance<=best){best=distance;nearest=zone.layer.key;}
      }
      if(nearest)return {layer:nearest};
      for(const puff of cloudFootprints){
        const d=((x-puff.x)**2+((y-puff.y)*1.35)**2)/(puff.radius**2);
        if(d<=best){best=d;nearest=puff.layer;}
      }
      if(nearest)return {layer:nearest};
    }
    let closest=null,distance=touch?21:14;
    for(const n of hit){
      if(layerKey&&n.layer.key!==layerKey)continue;
      const d=Math.hypot(n.screen[0]-x,n.screen[1]-y);
      if(d<distance){closest=n;distance=d;}
    }
    if(!closest)return null;
    return layerKey?{node:closest}:{layer:closest.layer.key};
  }
  function point(e){
    const rect=sky.getBoundingClientRect();
    return {x:e.clientX-rect.left,y:e.clientY-rect.top,touch:e.pointerType==='touch'};
  }
  function zoomBy(v){
    if(flight)return;
    camera.zoom=Math.min(layerKey?6:2.5,Math.max(layerKey?1.4:.60,camera.zoom*v));request();
  }
  function turn(dx,dy){
    if(flight)return;
    camera.yaw+=dx;camera.pitch=Math.max(-1,Math.min(1,camera.pitch+dy));request();
  }
  sky.addEventListener('pointerdown',e=>{if(flight||!e.isPrimary||e.button!==0)return;sky.setPointerCapture(e.pointerId);
    drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,moved:false,id:e.pointerId};sky.classList.add('dragging');});
  sky.addEventListener('pointermove',e=>{
    if(!drag){pointer=e.pointerType==='touch'?null:point(e);request();return;}
    if(e.pointerId!==drag.id)return;
    if(!drag.moved&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)<4)return;
    drag.moved=true;turn((e.clientX-drag.x)*.005,(drag.y-e.clientY)*.005);drag.x=e.clientX;drag.y=e.clientY;});
  sky.addEventListener('pointerup',e=>{
    if(!drag||drag.id!==e.pointerId)return;
    if(!drag.moved&&!flight){
      const target=pickAt(point(e));
      if(target)onPick(target.node?.item.key||null,target.layer);
    }
    drag=null;sky.classList.remove('dragging');request();
  });
  sky.addEventListener('lostpointercapture',()=>{drag=null;sky.classList.remove('dragging');request();});
  sky.addEventListener('pointerleave',()=>{pointer=null;request();});
  sky.addEventListener('wheel',e=>{e.preventDefault();zoomBy(Math.exp(-Math.max(-90,Math.min(90,e.deltaY))*.002));},{passive:false});
  document.addEventListener('visibilitychange',()=>{last=0;if(!document.hidden)request();});
  new ResizeObserver(resize).observe(sky);resize();
  return {install,focus,zoomBy,turn,get moving(){return moving;},
    motion(set){moving=set;request();}};
}
