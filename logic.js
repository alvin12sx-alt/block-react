/* Pure logic for Block React: drill onset/direction and jump + arm-swing analysis.
   Coordinates: isotropic (x scaled by aspect ratio), y down, units arbitrary. Times in ms. */
(function(root){
"use strict";
const ok=(p,th)=>!!p&&(p.visibility==null||p.visibility>=th);
const mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
const median=a=>{const s=[...a].sort((x,y)=>x-y),n=s.length;return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2};
function angle(a,b,c){
  const v1={x:a.x-b.x,y:a.y-b.y},v2={x:c.x-b.x,y:c.y-b.y},d=Math.hypot(v1.x,v1.y)*Math.hypot(v2.x,v2.y);
  if(!d)return null;
  return Math.acos(Math.max(-1,Math.min(1,(v1.x*v2.x+v1.y*v2.y)/d)))*180/Math.PI;
}

/* ---------- drill ---------- */
function torso(lm){
  if(!lm||![11,12,23,24].every(i=>ok(lm[i],.5)))return null;
  const sh=mid(lm[11],lm[12]),hip=mid(lm[23],lm[24]),S=dist(sh,hip);
  if(S<0.02)return null;
  return {cx:(sh.x+hip.x)/2,cy:(sh.y+hip.y)/2,S};
}
// samples: [{t,cx,cy,S}] (cx already in player's view: left = smaller x). k scales thresholds (1 = default; <1 more sensitive).
function drillStatus(samples,cueT,k){
  k=k||1;
  const o={lo:.05*k,hi:.12*k,lat:.14*k,win:350,pre:450,confirm:200};
  const pre=samples.filter(s=>s.t>=cueT-o.pre&&s.t<cueT);
  if(pre.length<3)return {state:'nobase'};
  const bx=avg(pre.map(s=>s.cx)),by=avg(pre.map(s=>s.cy)),S=avg(pre.map(s=>s.S));
  const post=samples.filter(s=>s.t>=cueT).map(s=>({t:s.t,dx:(s.cx-bx)/S,dy:(by-s.cy)/S}));
  let on=-1;
  for(let i=0;i<post.length&&on<0;i++){
    if(Math.hypot(post[i].dx,post[i].dy)<o.lo)continue;
    for(let j=i;j<post.length&&post[j].t<=post[i].t+o.confirm;j++)
      if(Math.hypot(post[j].dx,post[j].dy)>=o.hi){on=i;break}
  }
  if(on<0)return {state:'wait'};
  const t0=post[on].t,seg=post.filter(s=>s.t>=t0&&s.t<=t0+o.win);
  let mlat=0,up=0;
  for(const s of seg){if(Math.abs(s.dx)>Math.abs(mlat))mlat=s.dx;if(s.dy>up)up=s.dy}
  const last=post[post.length-1];
  if(!(last.t>=t0+o.win||Math.abs(mlat)>=o.lat*2))return {state:'tracking',onset:t0};
  const lateral=Math.abs(mlat)>=o.lat&&Math.abs(mlat)>=0.6*up;
  return {state:'done',onset:t0,dir:lateral?(mlat<0?'L':'R'):'M',dx:mlat,dy:up};
}
// deviation of the newest sample from a baseline built from the ~450ms before it, in torso units
function deviation(samples,now){
  const pre=samples.filter(s=>s.t>=now-900&&s.t<now-300);
  const last=samples[samples.length-1];
  if(pre.length<3||!last)return 0;
  const bx=avg(pre.map(s=>s.cx)),by=avg(pre.map(s=>s.cy)),S=avg(pre.map(s=>s.S));
  return Math.hypot((last.cx-bx)/S,(last.cy-by)/S);
}
function isStill(samples,now,ms,tol){
  const w=samples.filter(s=>s.t>=now-ms);
  if(w.length<5||w[0].t>now-ms+120)return false;
  const mx=avg(w.map(s=>s.cx)),my=avg(w.map(s=>s.cy)),S=avg(w.map(s=>s.S));
  return w.every(s=>Math.hypot((s.cx-mx)/S,(s.cy-my)/S)<tol);
}

/* ---------- jumps + arm swing ---------- */
const ARMS={left:{sh:11,el:13,wr:15,name:'L'},right:{sh:12,el:14,wr:16,name:'R'}};
function pts(lm){
  const need=[0,23,24,27,28];
  if(!lm||!need.every(i=>ok(lm[i],.4)))return null;
  const hip=mid(lm[23],lm[24]);
  return {lm,nose:lm[0],hip,ank:Math.max(lm[27].y,lm[28].y)};
}
function createJumpTracker(opts){
  opts=Object.assign({heightCm:175,arm:'auto'},opts);
  let state='calib',buf=[],cal=null,ground=[],air=null,calStart=0;
  const keep=2500;
  function tryCalibrate(t){
    const w=buf.filter(s=>s.t>=t-1500);
    if(w.length<12||w[0].t>t-1400)return {type:'calib-progress',p:Math.min(1,(t-(buf[0]?buf[0].t:t))/1500*0.5)};
    const ys=w.map(s=>s.nose.y),hs=w.map(s=>s.hip.y),as=w.map(s=>s.ank);
    const P0=(median(as)-median(ys))/0.88;
    const jitter=Math.max(Math.max(...ys)-Math.min(...ys),Math.max(...as)-Math.min(...as));
    if(P0<0.2||jitter>0.03*P0){buf=buf.filter(s=>s.t>=t-300);return {type:'calib-progress',p:0}}
    cal={P:P0,Ls:median(as)-median(hs),cm:opts.heightCm,g:median(as)};
    ground=w.map(s=>s.ank);state='ready';buf=[];
    return {type:'calibrated',cal};
  }
  function finish(tTake,tLand){
    const w=air.samples,g=air.g,cmu=cal.cm/cal.P;
    const hangMs=tLand-tTake;
    if(hangMs<180||hangMs>1500)return null;
    let apex=w[0];for(const s of w)if(s.t>=tTake&&s.t<=tLand&&s.hip.y<apex.hip.y)apex=s;
    const riseCm=((g-apex.hip.y)-cal.Ls)*cmu,hangCm=122.6*(hangMs/1000)**2;
    const sane=riseCm>=8&&riseCm<=130&&riseCm<hangCm*1.6+10;
    const m={t:tTake,hangMs:Math.round(hangMs),riseCm:Math.round(riseCm),hangCm:Math.round(hangCm),jumpCm:Math.round(sane?riseCm:hangCm),swing:false,tips:[]};
    const sides=opts.arm==='auto'?['left','right']:[opts.arm];
    let best=null;
    for(const sd of sides){
      const a=ARMS[sd];let pk=null;
      for(let i=2;i<w.length;i++){
        const s=w[i],p=w[i-2];
        if(s.t<tTake-250||s.t>tLand+80)continue;
        const L=s.lm,Lp=p.lm;
        if(!ok(L[a.wr],.3)||!ok(L[a.el],.3)||!ok(L[a.sh],.3)||!ok(Lp[a.wr],.3))continue;
        if(L[a.wr].y>L[a.sh].y)continue; // hand must be above shoulder
        const v=dist(L[a.wr],Lp[a.wr])/Math.max(1,s.t-p.t)*1000*cmu/100; // m/s
        if(!pk||v>pk.v)pk={v,i,t:s.t};
      }
      if(pk&&(!best||pk.v>best.v))best={...pk,side:sd,a};
    }
    if(best&&best.v>2){
      const s=w[best.i],L=s.lm,a=best.a;
      m.swing=true;m.arm=a.name;m.speed=+best.v.toFixed(1);
      m.contactCm=Math.round((g-L[a.wr].y)*cmu+0.04*cal.cm);
      m.elbow=Math.round(angle(L[a.sh],L[a.el],L[a.wr]));
      let dmin=999;
      for(const q of w)if(q.t>=best.t-450&&q.t<=best.t&&ok(q.lm[a.sh],.3)&&ok(q.lm[a.el],.3)&&ok(q.lm[a.wr],.3)){const an=angle(q.lm[a.sh],q.lm[a.el],q.lm[a.wr]);if(an!=null&&an<dmin)dmin=an}
      m.drawMin=dmin<999?Math.round(dmin):null;
      m.apexOffset=Math.round(best.t-apex.t);
      if(m.elbow<150)m.tips.push('Elbow only '+m.elbow+'° at contact. Reach up and straighten the arm through the ball.');
      if(m.apexOffset<-120)m.tips.push('You swung '+(-m.apexOffset)+' ms before the top of your jump. Wait for the apex, then hit.');
      if(m.apexOffset>120)m.tips.push('You hit '+m.apexOffset+' ms after the top, on the way down. Start the swing earlier.');
      if(m.drawMin!=null&&m.drawMin>125)m.tips.push('Backswing elbow barely bent ('+m.drawMin+'°). Pull the elbow back and high before you whip the arm.');
      if(m.speed<7)m.tips.push('Hand speed '+m.speed+' m/s is low. Snap from the shoulder and finish with the wrist.');
      if(!m.tips.length)m.tips.push('Clean swing. Timing, reach and arm path all look good.');
    }else m.tips.push('No overhead arm swing seen. Keep your hitting arm in view, side-on to the camera.');
    return m;
  }
  function feed(t,lm){
    const p=pts(lm);if(!p)return [];
    const s={t,...p};
    if(state==='calib'){buf.push(s);buf=buf.filter(x=>x.t>=t-keep);const e=tryCalibrate(t);return [e]}
    buf.push(s);buf=buf.filter(x=>x.t>=t-keep);
    const P=cal.P;
    if(!air){
      const g=median(ground.slice(-20));
      if(s.ank<g-0.035*P){
        const recent=buf.filter(x=>x.t>=t-250);
        let tT=t;for(const x of recent)if(x.ank<g-0.012*P){tT=x.t;break}
        air={g,tTake:tT,samples:buf.filter(x=>x.t>=tT-500),n:0};
      }else{ground.push(s.ank);if(ground.length>60)ground.shift()}
      return [];
    }
    air.samples.push(s);
    const inAir=s.ank<air.g-0.012*P;
    if(inAir){air.n=0;if(t-air.tTake>1600){air=null}return []}
    if(++air.n<2&&t-air.tTake<1600)return [];
    const m=finish(air.tTake,t);air=null;
    return m?[{type:'jump',m}]:[];
  }
  return {feed,get state(){return state},get cal(){return cal},reset(){state='calib';buf=[];cal=null;air=null;ground=[]}};
}

const api={torso,drillStatus,deviation,isStill,createJumpTracker,angle};
if(typeof module!=='undefined')module.exports=api;else root.BR=api;
})(typeof window!=='undefined'?window:globalThis);
