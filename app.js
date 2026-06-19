/* ===================================================================
   PECUNIA · Plateforme créateurs — app.js
   Backend : Supabase (auth + Postgres + RLS + RPC). Voir supabase/schema.sql
   =================================================================== */

const cfg = window.PECUNIA_CONFIG || {};
let sb = null;
try { sb = window.supabase.createClient(cfg.url, cfg.anonKey); } catch (e) { console.error('Supabase init', e); }

/* ---------- préférences locales (appareil admin) ---------- */
const LP = {
  get ytKey(){ try { return localStorage.getItem('pecunia_ytkey') || ''; } catch(e){ return ''; } },
  set ytKey(v){ try { localStorage.setItem('pecunia_ytkey', v || ''); } catch(e){} },
  get force(){ try { return localStorage.getItem('pecunia_force') === '1'; } catch(e){ return false; } },
  set force(v){ try { localStorage.setItem('pecunia_force', v ? '1' : '0'); } catch(e){} }
};

/* ---------- état ---------- */
let config = null, creators = [], videos = [], session = null, adminTab = 'overview', selMonth = null, authMode = 'login';

/* ---------- utilitaires ---------- */
const MARK = `<svg width="26" height="26" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 27V6h7a6 6 0 0 1 0 12h-7"/></svg>`;
const eur = n => (Number(n)||0).toLocaleString('fr-FR',{style:'currency',currency:'EUR',minimumFractionDigits:2,maximumFractionDigits:2});
const numfmt = n => (Number(n)||0).toLocaleString('fr-FR');
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const val = id => { const e=document.getElementById(id); return e?e.value.trim():''; };
const app = () => document.getElementById('app');
const PLATFORMS = {youtube:{name:'YouTube',color:'#FF4E45',auto:true},tiktok:{name:'TikTok',color:'#69C9D0',auto:false},instagram:{name:'Instagram',color:'#E1306C',auto:false},autre:{name:'Autre',color:'#86a0b2',auto:false}};
const ANGLES = [{code:'A',name:'Peur retournée',short:'A · Peur',color:'#E5675C'},{code:'B',name:'Simulateur de crise',short:'B · Simulateur',color:'#3ddc97'},{code:'C',name:'Confiance tranquille',short:'C · Confiance',color:'#5AA9E6'},{code:'D',name:'Score comportemental',short:'D · Score',color:'#E2A93C'}];
const angleBy = c => ANGLES.find(a=>a.code===c)||null;
function angleChip(code){const a=angleBy(code);if(!a)return '<span class="anglechip" style="--ac:#86a0b2">Sans angle</span>';return `<span class="anglechip" style="--ac:${a.color}">${esc(a.short)}</span>`;}
function creatorOf(v){return creators.find(x=>x.id===v.creatorId)||{};}
const nowMonth = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); };
const monthLabel = k => { if(!k) return ''; const[y,m]=k.split('-'); return new Date(Number(y),Number(m)-1,1).toLocaleDateString('fr-FR',{month:'long',year:'numeric'}); };
const monthShort = k => { const[y,m]=k.split('-'); return new Date(Number(y),Number(m)-1,1).toLocaleDateString('fr-FR',{month:'short'}).replace('.',''); };
const ytId = u => { if(!u) return null; const m=String(u).match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/); return m?m[1]:null; };
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2800);}

/* ===================================================================
   DONNÉES (Supabase)
   =================================================================== */
function mapProfile(p){return {id:p.id,name:p.name,handle:p.handle,rate:(p.rate==null?null:Number(p.rate)),cap:(p.cap==null?null:Number(p.cap)),approved:p.approved,role:p.role};}

async function loadAll(){
  // config
  const {data:cfgRow} = await sb.from('app_config').select('*').eq('id',1).maybeSingle();
  config = cfgRow ? {rpmRate:Number(cfgRow.rpm_rate),cap:Number(cfgRow.cap),declareOpen:cfgRow.declare_open,declareClose:cfgRow.declare_close,payDay:cfgRow.pay_day}
                  : {rpmRate:1,cap:200,declareOpen:25,declareClose:28,payDay:30};
  config.windowForce = LP.force; config.ytKey = LP.ytKey;
  // profils
  if(session.role==='admin'){
    const {data:profs} = await sb.from('profiles').select('*').eq('role','creator').order('name');
    creators = (profs||[]).map(mapProfile);
  } else {
    creators = [ mapProfile(session.profile) ];
  }
  // vidéos + relevés (RLS limite automatiquement au créateur connecté)
  const {data:vids} = await sb.from('videos').select('*').order('created_at',{ascending:false});
  const {data:reads} = await sb.from('readings').select('*');
  videos = (vids||[]).map(v=>({id:v.id,creatorId:v.creator_id,platform:v.platform,url:v.url,title:v.title,angle:v.angle,note:v.note,createdAt:v.created_at,readings:{},payments:{}}));
  const vmap={}; videos.forEach(v=>vmap[v.id]=v);
  (reads||[]).forEach(r=>{const v=vmap[r.video_id];if(!v)return;v.readings[r.month]={declared:r.declared,validated:r.validated,status:r.status};if(r.paid)v.payments[r.month]=true;});
  if(!selMonth) selMonth = nowMonth();
}

/* ===================================================================
   MOTEUR DE RÉMUNÉRATION (par vidéo, mensuel incrémental)
   =================================================================== */
function rateFor(c){return (c&&c.rate!=null&&c.rate!=='')?Number(c.rate):Number(config.rpmRate);}
function capFor(c){return (c&&c.cap!=null&&c.cap!=='')?Number(c.cap):Number(config.cap);}
function cumPay(views,c){return Math.min((Number(views)||0)/1000*rateFor(c),capFor(c));}
function rdg(v,m){return (v.readings||{})[m]||null;}
function isValidated(v,m){const r=rdg(v,m);return !!(r&&r.status==='validated');}
function valViews(v,m){const r=rdg(v,m);return r?(r.validated!=null?r.validated:r.declared):0;}
function validatedMonths(v){return Object.keys(v.readings||{}).filter(m=>isValidated(v,m)).sort();}
function allMonths(v){return Object.keys(v.readings||{}).sort();}
function vIncrements(v,c){const o={};let prev=0;for(const m of validatedMonths(v)){const p=cumPay(valViews(v,m),c);o[m]=p-prev;prev=p;}return o;}
function vLatestValidViews(v){const m=validatedMonths(v);return m.length?valViews(v,m[m.length-1]):0;}
function vTotalPay(v,c){return cumPay(vLatestValidViews(v),c);}
function vDisplayViews(v){const m=allMonths(v);if(!m.length)return 0;const r=rdg(v,m[m.length-1]);return (r.status==='validated'&&r.validated!=null)?r.validated:r.declared;}
function vPaid(v,c){const i=vIncrements(v,c);let s=0;for(const m in i){if(v.payments&&v.payments[m])s+=i[m];}return s;}
function vDue(v,c){const i=vIncrements(v,c);let s=0;for(const m in i){if(!(v.payments&&v.payments[m]))s+=i[m];}return s;}
function vCapped(v,c){return vTotalPay(v,c)>=capFor(c)-0.0001;}
function monthIncPreview(views,v,c,m){const tmp=Object.assign({},v,{readings:Object.assign({},v.readings,{[m]:{declared:views,validated:views,status:'validated'}})});return vIncrements(tmp,c)[m]||0;}
function cycleStatus(v){const r=rdg(v,nowMonth());if(!r)return 'todo';return r.status;}
function creatorStats(c){const vids=videos.filter(v=>v.creatorId===c.id);let earned=0,paid=0,due=0,views=0,todo=0,declared=0;
  for(const v of vids){earned+=vTotalPay(v,c);paid+=vPaid(v,c);due+=vDue(v,c);views+=vDisplayViews(v);const st=cycleStatus(v);if(st==='todo')todo++;if(st==='declared')declared++;}
  return {vids,count:vids.length,earned,paid,due,views,todo,declared};}
function totals(){let earned=0,paid=0,due=0,views=0;for(const c of creators){const s=creatorStats(c);earned+=s.earned;paid+=s.paid;due+=s.due;views+=s.views;}
  const pend=videos.filter(v=>{const r=rdg(v,nowMonth());return r&&r.status==='declared';}).length;
  return {earned,paid,due,views,creators:creators.length,videos:videos.length,pend};}

/* ---------- fenêtre / cycle ---------- */
function windowInfo(){const o=config.declareOpen,cl=config.declareClose,p=config.payDay;
  if(config.windowForce)return {open:true,forced:true,o,cl,p,next:null};
  const d=new Date(),day=d.getDate();const open=day>=o&&day<=cl;let next=null;
  if(!open){ if(day<o)next=`du ${o} au ${cl} ${monthLabel(nowMonth())}`;
    else{const nx=new Date(d.getFullYear(),d.getMonth()+1,1);next=`du ${o} au ${cl} ${monthLabel(nx.getFullYear()+'-'+String(nx.getMonth()+1).padStart(2,'0'))}`;} }
  return {open,forced:false,o,cl,p,next};}

/* ===================================================================
   GRAPHIQUES (SVG natif)
   =================================================================== */
let _cs=0;
function chartEmpty(msg){return `<div class="chartempty">${msg||'Les graphiques apparaîtront dès les premières vues validées.'}</div>`;}
function barChartV(items,opts){opts=opts||{};const money=opts.money,h=opts.h||190;const vals=items.map(i=>i.value||0);if(!items.length||vals.every(v=>!v))return chartEmpty(opts.empty);
  const max=Math.max.apply(null,vals)||1;const W=520,padL=14,padR=14,padT=22,padB=44,innerH=h-padT-padB;const slot=(W-padL-padR)/items.length;const bw=Math.min(70,slot*0.5);
  let b=`<line x1="${padL}" y1="${padT+innerH}" x2="${W-padR}" y2="${padT+innerH}" stroke="var(--line-2)"></line>`;
  items.forEach((it,i)=>{const x=padL+slot*i+slot/2;const bh=Math.max(2,innerH*((it.value||0)/max));const y=padT+innerH-bh;
    b+=`<rect x="${(x-bw/2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="5" fill="${it.color||'#3ddc97'}" opacity="0.92"></rect>`;
    b+=`<text x="${x.toFixed(1)}" y="${(y-6).toFixed(1)}" text-anchor="middle" class="cval">${money?eur(it.value):numfmt(Math.round(it.value))}</text>`;
    b+=`<text x="${x.toFixed(1)}" y="${padT+innerH+16}" text-anchor="middle" class="clbl">${esc(it.label)}</text>`;
    if(it.sub)b+=`<text x="${x.toFixed(1)}" y="${padT+innerH+30}" text-anchor="middle" class="csub">${esc(it.sub)}</text>`;});
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" preserveAspectRatio="xMidYMid meet">${b}</svg>`;}
function areaChart(points,opts){opts=opts||{};const money=opts.money,h=opts.h||185,color=opts.color||'#3ddc97';const vals=points.map(p=>p.value||0);if(!points.length||vals.every(v=>!v))return chartEmpty(opts.empty);
  const W=520,padL=46,padR=14,padT=18,padB=34,innerW=W-padL-padR,innerH=h-padT-padB,n=points.length,max=Math.max.apply(null,vals)||1;const id='ag'+(++_cs);
  const X=i=>n===1?padL+innerW/2:padL+innerW*(i/(n-1));const Y=v=>padT+innerH-innerH*(v/max);
  let d='';points.forEach((p,i)=>{d+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(p.value||0).toFixed(1)+' ';});
  const area=`M${X(0).toFixed(1)} ${(padT+innerH).toFixed(1)} `+points.map((p,i)=>'L'+X(i).toFixed(1)+' '+Y(p.value||0).toFixed(1)).join(' ')+` L${X(n-1).toFixed(1)} ${(padT+innerH).toFixed(1)} Z`;
  let grid='';for(let g=0;g<=2;g++){const v2=max*g/2,y=Y(v2);grid+=`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="var(--line)"></line><text x="${padL-6}" y="${(y+3).toFixed(1)}" text-anchor="end" class="csub">${money?eur(v2):numfmt(Math.round(v2))}</text>`;}
  let xl='';const idxs=n<=4?points.map((_,i)=>i):[0,Math.floor((n-1)/2),n-1];idxs.forEach(i=>{xl+=`<text x="${X(i).toFixed(1)}" y="${padT+innerH+18}" text-anchor="middle" class="clbl">${esc(points[i].label)}</text>`;});
  const dots=points.map((p,i)=>`<circle cx="${X(i).toFixed(1)}" cy="${Y(p.value||0).toFixed(1)}" r="3" fill="${color}"></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${h}" class="chart" preserveAspectRatio="xMidYMid meet"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.28"></stop><stop offset="1" stop-color="${color}" stop-opacity="0"></stop></linearGradient></defs>${grid}<path d="${area}" fill="url(#${id})"></path><path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>${dots}${xl}</svg>`;}
function seriesFor(vids){const set=new Set();vids.forEach(v=>validatedMonths(v).forEach(m=>set.add(m)));const months=[...set].sort();const dV={},dE={};months.forEach(m=>{dV[m]=0;dE[m]=0;});
  vids.forEach(v=>{const c=creatorOf(v);let pv=0,pp=0;validatedMonths(v).forEach(m=>{const vv=valViews(v,m),pay=cumPay(vv,c);dV[m]+=(vv-pv);dE[m]+=(pay-pp);pv=vv;pp=pay;});});
  let cv=0;const cumV=[],earnPts=[];months.forEach(m=>{cv+=dV[m];cumV.push({label:monthShort(m),value:cv});earnPts.push({label:monthShort(m),value:dE[m]});});return {months,cumV,earnPts};}
function angleStats(vids){const out={};ANGLES.forEach(a=>out[a.code]=Object.assign({},a,{videos:0,views:0,earned:0,avg:0}));
  vids.forEach(v=>{const a=v.angle;if(!out[a])return;const c=creatorOf(v);out[a].videos++;out[a].views+=vDisplayViews(v);out[a].earned+=vTotalPay(v,c);});
  Object.values(out).forEach(o=>o.avg=o.videos?o.views/o.videos:0);return out;}
function chartCard(title,svg,hint){return `<div class="panel"><div class="panel-h"><h2>${title}</h2>${hint?`<span class="hint">${hint}</span>`:''}</div><div class="panel-b" style="padding:16px 14px 10px">${svg}</div></div>`;}
function overviewCharts(){const s=seriesFor(videos);const ang=angleStats(videos);
  const angItems=ANGLES.map(a=>({label:a.code,sub:numfmt(Math.round(ang[a.code].avg)),value:ang[a.code].avg,color:a.color}));
  return `<div class="charts">${chartCard('Rémunération par mois',areaChart(s.earnPts,{money:true,color:'#3ddc97'}),'gains validés')}${chartCard('Vues cumulées',areaChart(s.cumV,{color:'#5AA9E6'}),'toutes vidéos')}</div>${chartCard('Vues moyennes par vidéo, par angle',barChartV(angItems,{empty:'Ajoute des vidéos avec un angle pour voir la performance.'}),'le signal pour piloter la stratégie')}`;}
function creatorCharts(c){const vids=videos.filter(v=>v.creatorId===c.id);const s=seriesFor(vids);const ang=angleStats(vids);
  const angItems=ANGLES.map(a=>({label:a.code,sub:numfmt(Math.round(ang[a.code].avg)),value:ang[a.code].avg,color:a.color}));
  return `<div class="charts">${chartCard('Ma rémunération par mois',areaChart(s.earnPts,{money:true,color:'#3ddc97'}),'gains validés')}${chartCard('Mes vues cumulées',areaChart(s.cumV,{color:'#5AA9E6'}),'toutes mes vidéos')}</div>${chartCard('Mes angles qui marchent (vues moy./vidéo)',barChartV(angItems,{empty:'Ajoute des vidéos avec un angle pour voir ce qui marche le mieux.'}),'fais-en plus sur l’angle qui performe')}`;}

/* ===================================================================
   RENDU
   =================================================================== */
function render(){
  if(!sb || !cfg.url || cfg.url.indexOf('VOTRE-PROJET')>=0){ return renderConfigError(); }
  if(!session){ return renderAuth(); }
  if(session.role==='creator' && !session.profile.approved){ return renderPending(); }
  if(session.role==='admin'){ return renderAdmin(); }
  return renderCreator();
}
function kpi(l,v,s,hero){return `<div class="kpi ${hero?'hero':''}"><div class="lbl">${l}</div><div class="val num">${v}</div>${s?`<div class="sub">${s}</div>`:''}</div>`;}

function renderConfigError(){app().innerHTML=`<div class="auth"><div class="auth-card"><div class="mark">${MARK}</div>
  <h1>Configuration requise</h1><p class="lede">Renseigne <b>config.js</b> avec l'URL et la clé anon de ton projet Supabase, puis recharge la page.</p></div></div>`;}

function renderAuth(){
  if(authMode==='signup'){
    app().innerHTML=`<div class="auth"><div class="auth-card"><div class="mark">${MARK}</div>
      <h1>Créer mon compte créateur</h1><p class="lede">Inscris-toi pour déposer tes vidéos. Ton accès sera activé par Pecunia.</p><div id="signupErr"></div>
      <label class="field"><span>Nom</span><input class="input" id="su_name" placeholder="ex. Camille R." autocomplete="name"></label>
      <label class="field"><span>Email</span><input class="input" id="su_email" type="email" autocomplete="email"></label>
      <label class="field"><span>Mot de passe</span><input class="input" id="su_pw" type="password" autocomplete="new-password" placeholder="6 caractères minimum"></label>
      <button class="btn primary" style="width:100%;justify-content:center" data-action="signup-go">Créer mon compte</button>
      <p class="auth-foot">Déjà un compte ? <a href="#" data-action="to-login">Se connecter</a></p></div></div>`;
  } else {
    app().innerHTML=`<div class="auth"><div class="auth-card"><div class="mark">${MARK}</div>
      <h1>Pecunia · Créateurs</h1><p class="lede">Connecte-toi pour accéder à ton espace.</p><div id="loginErr"></div>
      <label class="field"><span>Email</span><input class="input" id="lg_email" type="email" autocomplete="email" autofocus></label>
      <label class="field"><span>Mot de passe</span><input class="input" id="lg_pw" type="password" autocomplete="current-password"></label>
      <button class="btn primary" style="width:100%;justify-content:center" data-action="login-go">Se connecter</button>
      <p class="auth-foot">Tu es créateur et pas encore inscrit ? <a href="#" data-action="to-signup">Créer un compte</a></p></div></div>`;
    const i=document.getElementById('lg_pw');if(i)i.addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
  }
}
function renderPending(){app().innerHTML=topbar(session.profile.name||'Créateur','Créateur',false)+`<div class="wrap">
  <div class="banner warn"><div><b>Compte en attente d'activation.</b> Pecunia doit valider ton accès. Reviens un peu plus tard, ou contacte l'équipe.</div></div>
  <div class="empty"><h3>Bientôt prêt</h3><p>Dès que ton compte est activé, tu pourras déposer tes vidéos et suivre ta rémunération ici.</p></div></div>`;}
function authErr(id,msg){const e=document.getElementById(id);if(e)e.innerHTML=`<div class="auth-err">${esc(msg)}</div>`;}

function topbar(name,role,isAdmin){return `<div class="topbar"><div class="brand"><div class="mark">${MARK}</div><div>Pecunia<small>Plateforme créateurs</small></div></div>
  <div class="spacer"></div><div class="who"><span><b>${esc(name)}</b></span><span class="role-chip ${isAdmin?'':'creator'}">${role}</span>
  <button class="btn ghost sm" data-action="logout">Se déconnecter</button></div></div>`;}

/* ----------------------------- ADMIN ----------------------------- */
function renderAdmin(){const t=totals();
  const tabs=[['overview','Vue d’ensemble'],['cycle','Déclarations',t.pend||''],['angles','Angles & perf'],['creators','Créateurs'],['payments','Paiements'],['settings','Réglages']];
  app().innerHTML=topbar(session.profile.name||'Admin','Maître',true)+`<div class="wrap"><div class="tabs" role="tablist">${tabs.map(([id,l,c])=>`<button class="tab" role="tab" aria-selected="${adminTab===id}" data-tab="${id}">${l}${c?`<span class="count">${c}</span>`:''}</button>`).join('')}</div><div id="tabpane"></div></div>`;
  renderAdminTab();}
function renderAdminTab(){const p=document.getElementById('tabpane');if(!p)return;
  p.innerHTML=({overview:adminOverview,cycle:adminCycle,angles:adminAngles,creators:adminCreators,payments:adminPayments,settings:adminSettings}[adminTab]||adminOverview)();
  const s=document.getElementById('monthSel');if(s)s.addEventListener('change',e=>{selMonth=e.target.value;renderAdminTab();});}

function adminOverview(){const t=totals();const w=windowInfo();
  let h=`<div class="banner ${w.open?'open':'closed'}">${w.open?'<div class="dotpulse"></div>':''}<div>${w.open?`<b>Fenêtre de déclaration ouverte</b>${w.forced?' (manuel)':` jusqu'au ${w.cl}`}. Paiement prévu le ${w.p}.`:`<b>Fenêtre fermée.</b> Prochaine déclaration ${w.next}. Paiement le ${w.p}.`}</div></div>`;
  h+=`<div class="kpis">${kpi('À payer maintenant',eur(t.due),`${creators.filter(c=>creatorStats(c).due>0.001).length} créateur(s) avec solde`,true)}${kpi('À valider ce cycle',numfmt(t.pend),t.pend?'déclarations en attente':'rien en attente')}${kpi('Déjà payé',eur(t.paid),'cumul versé')}${kpi('Gains cumulés',eur(t.earned),'généré à ce jour')}${kpi('Vues suivies',numfmt(t.views),'dernier relevé')}${kpi('Créateurs',numfmt(t.creators),`${t.videos} vidéo(s)`)}</div>`;
  h+=overviewCharts();
  if(!creators.length)return h+`<div class="panel"><div class="panel-b"><div class="empty"><h3>Aucun créateur actif</h3><p>Onglet Créateurs : les créateurs s'inscrivent eux-mêmes, tu les actives ici.</p></div></div></div>`;
  const rows=creators.map(c=>{const s=creatorStats(c);return `<tr class="row"><td><div class="creator-cell"><div class="ava">${esc((c.name||'?').slice(0,2).toUpperCase())}</div><div><div>${esc(c.name)}</div><div class="h">${esc(c.handle||'—')}</div></div></div></td><td class="r num">${numfmt(s.views)}</td><td class="r num">${s.count}</td><td class="r num">${eur(s.earned)}</td><td class="r num">${eur(s.paid)}</td><td class="r num" style="color:${s.due>0.001?'var(--jade-2)':'var(--mist)'};font-weight:600">${eur(s.due)}</td><td class="r"><button class="btn sm" data-action="open-creator" data-id="${c.id}">Détail</button></td></tr>`;}).join('');
  return h+`<div class="panel"><div class="panel-h"><h2>Récapitulatif par créateur</h2><span class="hint">solde = gains cumulés − déjà payé</span></div><div class="panel-b tscroll"><table><thead><tr><th>Créateur</th><th class="r">Vues</th><th class="r">Vidéos</th><th class="r">Gains cumulés</th><th class="r">Payé</th><th class="r">Solde dû</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;}

function monthOptions(){const set=new Set([nowMonth(),selMonth]);videos.forEach(v=>allMonths(v).forEach(m=>set.add(m)));
  const d=new Date();for(let i=-1;i<=1;i++){const x=new Date(d.getFullYear(),d.getMonth()+i,1);set.add(x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0'));}
  return [...set].filter(Boolean).sort().reverse().map(m=>`<option value="${m}" ${m===selMonth?'selected':''}>${monthLabel(m)}</option>`).join('');}

function adminCycle(){const w=windowInfo();const hasYT=videos.some(v=>v.platform==='youtube'&&ytId(v.url));const ytReady=!!(config.ytKey&&config.ytKey.trim());
  const late=creators.map(c=>({c,s:creatorStats(c)})).filter(x=>x.s.todo>0);
  let head=`<div class="panel"><div class="panel-h"><h2>Cycle de déclaration</h2><div class="spacer"></div><div class="selrow"><span class="hint">Mois&nbsp;:</span><select class="sel" id="monthSel">${monthOptions()}</select><button class="btn sm" data-action="toggle-window">${w.open&&w.forced?'Fermer la fenêtre':'Ouvrir la fenêtre (manuel)'}</button>${hasYT?`<button class="btn primary sm" data-action="yt-pull" ${ytReady?'':'disabled'}>Relever YouTube (auto)</button>`:''}</div></div>
    <div class="panel-b" style="padding:14px 18px"><div class="banner ${w.open?'open':'closed'}" style="margin:0">${w.open?'<div class="dotpulse"></div>':''}<div>${w.open?`<b>Fenêtre ouverte</b>${w.forced?' (manuel)':` (jour ${w.o}–${w.cl})`} · paiement le ${w.p}.`:`<b>Fenêtre fermée.</b> Prochaine ${w.next}.`}</div></div></div></div>`;
  if(late.length){head+=`<div class="panel"><div class="panel-h"><h2>Relances</h2><span class="hint">${late.length} créateur(s) sans déclaration ce cycle</span><div class="spacer"></div><button class="btn sm" data-action="copy-reminder">Copier le message de rappel</button></div><div class="panel-b" style="padding:6px 18px 14px"><div class="num" style="font-size:12px;color:var(--mist)">${late.map(x=>`${esc(x.c.name)} (${x.s.todo})`).join('  ·  ')}</div><p class="help">Les emails automatiques nécessitent une fonction planifiée (chantier dev). Ici tu relances en 30 s avec le message prêt à coller.</p></div></div>`;}
  if(!videos.length)return head+`<div class="panel"><div class="panel-b"><div class="empty"><h3>Aucune vidéo</h3><p>Les vidéos apparaissent dès qu'un créateur dépose un lien.</p></div></div></div>`;
  const rows=videos.map(v=>{const c=creatorOf(v);const p=PLATFORMS[v.platform]||PLATFORMS.autre;const r=rdg(v,selMonth);
    const st=!r?'<span class="badge b-todo">à déclarer</span>':r.status==='validated'?'<span class="badge b-validated">validé</span>':'<span class="badge b-declared">à valider</span>';
    const declared=r?(r.declared!=null?numfmt(r.declared):'—'):'—';const valid=r&&r.status==='validated'?numfmt(r.validated):'—';
    const inc=isValidated(v,selMonth)?eur(vIncrements(v,c)[selMonth]||0):(r?eur(monthIncPreview(r.declared,v,c,selMonth)):'—');
    return `<tr class="row"><td><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(v.title||'Vidéo')} ${angleChip(v.angle)}</div><div class="h muted"><a href="${esc(v.url)}" target="_blank" rel="noopener">lien ↗</a> · ${esc(c.name||'—')}</div></td><td><span class="plat"><span class="dot" style="background:${p.color}"></span>${p.name}</span></td><td class="r num">${declared}</td><td class="r num">${valid}</td><td class="r num">${inc}${isValidated(v,selMonth)&&vCapped(v,c)?' <span class="badge b-cap">plafond</span>':''}</td><td class="r">${st}</td><td class="r"><button class="btn sm ${r&&r.status!=='validated'?'primary':'ghost'}" data-action="validate" data-id="${v.id}">${r&&r.status==='validated'?'Réviser':'Valider'}</button></td></tr>`;}).join('');
  return head+`<div class="panel"><div class="panel-h"><h2>${monthLabel(selMonth)}</h2><span class="hint">déclaré par le créateur · validé par toi (montant ferme)</span></div><div class="panel-b tscroll"><table><thead><tr><th>Vidéo</th><th>Plateforme</th><th class="r">Déclaré</th><th class="r">Validé</th><th class="r">Gain du mois</th><th class="r">Statut</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;}

function adminAngles(){const ang=angleStats(videos);const arr=ANGLES.map(a=>ang[a.code]);
  const best=arr.filter(o=>o.videos).sort((a,b)=>b.avg-a.avg)[0];
  const avgItems=ANGLES.map(a=>({label:a.code,sub:numfmt(Math.round(ang[a.code].avg)),value:ang[a.code].avg,color:a.color}));
  const totItems=ANGLES.map(a=>({label:a.code,value:ang[a.code].views,color:a.color}));
  const top=videos.map(v=>({v,c:creatorOf(v),views:vDisplayViews(v)})).sort((a,b)=>b.views-a.views).slice(0,8);
  const rows=arr.map(o=>`<tr class="row"><td>${angleChip(o.code)} <span class="muted" style="font-size:12px">${esc(o.name)}</span></td><td class="r num">${o.videos}</td><td class="r num">${numfmt(o.views)}</td><td class="r num">${numfmt(Math.round(o.avg))}</td><td class="r num">${eur(o.earned)}</td></tr>`).join('');
  const lrows=top.length&&top[0].views?top.filter(t=>t.views).map(t=>`<tr class="row"><td><div>${esc(t.v.title||'Vidéo')}</div><div class="h muted">${esc(t.c.name||'—')}</div></td><td>${angleChip(t.v.angle)}</td><td>${(PLATFORMS[t.v.platform]||PLATFORMS.autre).name}</td><td class="r num">${numfmt(t.views)}</td></tr>`).join(''):'<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">Pas encore de vues relevées</td></tr>';
  return `${best?`<div class="banner open"><div class="dotpulse"></div><div><b>Angle le plus performant : ${esc(best.short)}</b> — ${numfmt(Math.round(best.avg))} vues/vidéo en moyenne. Brief créateurs : on pousse cet angle.</div></div>`:'<div class="banner closed"><div>Pas encore assez de données. Les angles se classeront dès les premières vues validées.</div></div>'}
   <div class="charts">${chartCard('Vues moyennes / vidéo, par angle',barChartV(avgItems,{empty:'Pas encore de données.'}),'qui convertit l’attention')}${chartCard('Vues totales par angle',barChartV(totItems,{empty:'Pas encore de données.'}),'volume brut')}</div>
   <div class="panel"><div class="panel-h"><h2>Performance par angle</h2><span class="hint">la moyenne par vidéo est le vrai juge de paix</span></div><div class="panel-b tscroll"><table><thead><tr><th>Angle</th><th class="r">Vidéos</th><th class="r">Vues</th><th class="r">Vues moy./vidéo</th><th class="r">Rémunération</th></tr></thead><tbody>${rows}</tbody></table></div></div>
   <div class="panel"><div class="panel-h"><h2>Top vidéos</h2><span class="hint">ce qui marche, à dupliquer</span></div><div class="panel-b tscroll"><table><thead><tr><th>Vidéo</th><th>Angle</th><th>Plateforme</th><th class="r">Vues</th></tr></thead><tbody>${lrows}</tbody></table></div></div>`;}

function adminCreators(){let body;
  if(!creators.length)body=`<div class="empty"><h3>Aucun créateur inscrit</h3><p>Les créateurs créent leur compte eux-mêmes depuis le lien de la plateforme, puis apparaissent ici pour activation.</p><div style="margin-top:16px"><button class="btn primary" data-action="invite-creator">Comment inviter un créateur</button></div></div>`;
  else{const rows=creators.map(c=>{const s=creatorStats(c);return `<tr class="row"><td><div class="creator-cell"><div class="ava">${esc((c.name||'?').slice(0,2).toUpperCase())}</div><div><div>${esc(c.name)}</div><div class="h">${esc(c.handle||'—')}</div></div></div></td><td>${c.approved?'<span class="badge b-on">actif</span>':'<span class="badge b-off">en attente</span>'}</td><td class="num">${rateFor(c)} €/1k · plaf. ${capFor(c)} €</td><td class="r num">${s.count}</td><td class="r num">${eur(s.due)}</td><td class="r"><div class="rowbtns">${c.approved?'':`<button class="btn primary sm" data-action="approve" data-id="${c.id}">Activer</button>`}<button class="btn sm ghost" data-action="edit-creator" data-id="${c.id}">Barème</button></div></td></tr>`;}).join('');
    body=`<div class="tscroll"><table><thead><tr><th>Créateur</th><th>Statut</th><th>Barème</th><th class="r">Vidéos</th><th class="r">Solde dû</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;}
  return `<div class="panel"><div class="panel-h"><h2>Créateurs</h2><span class="hint">active les nouveaux comptes et règle leur barème</span><div class="spacer"></div><button class="btn sm" data-action="invite-creator">Inviter</button></div><div class="panel-b">${body}</div></div>`;}

function adminPayments(){const list=creators.map(c=>({c,s:creatorStats(c)})).filter(x=>x.s.earned>0.001);const t=totals();const w=windowInfo();
  if(!list.length)return `<div class="panel"><div class="panel-b"><div class="empty"><h3>Rien à payer pour l'instant</h3><p>Dès qu'une déclaration est validée, le gain du mois apparaît ici.</p></div></div></div>`;
  const rows=list.map(({c,s})=>`<tr class="row"><td><div class="creator-cell"><div class="ava">${esc((c.name||'?').slice(0,2).toUpperCase())}</div><div><div>${esc(c.name)}</div><div class="h">${s.count} vidéo(s)</div></div></div></td><td class="r num">${eur(s.earned)}</td><td class="r num">${eur(s.paid)}</td><td class="r num" style="font-weight:600;color:${s.due>0.001?'var(--jade-2)':'var(--mist)'}">${eur(s.due)}</td><td class="r"><div class="rowbtns"><button class="btn sm" data-action="open-creator" data-id="${c.id}">Détail</button><button class="btn primary sm" data-action="pay-all" data-id="${c.id}" ${s.due>0.001?'':'disabled'}>Marquer payé</button></div></td></tr>`).join('');
  return `<div class="banner closed">Paiement prévu le <b style="color:var(--paper)">${w.p}</b>. « Marquer payé » solde tous les gains validés non versés du créateur.</div><div class="kpis">${kpi('Total à payer',eur(t.due),'gains validés non versés',true)}${kpi('Déjà versé',eur(t.paid),'cumul')}</div><div class="panel"><div class="panel-h"><h2>Soldes à payer</h2></div><div class="panel-b tscroll"><table><thead><tr><th>Créateur</th><th class="r">Gains cumulés</th><th class="r">Payé</th><th class="r">Solde dû</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;}

function adminSettings(){const ytReady=!!(config.ytKey&&config.ytKey.trim());
  return `<div class="panel"><div class="panel-h"><h2>Barème par défaut</h2></div><div class="panel-b" style="padding:18px"><div class="grid2"><label class="field"><span>Taux RPM (€ / 1000 vues)</span><input class="input num" id="set_rate" type="number" step="0.1" value="${config.rpmRate}"></label><label class="field"><span>Plafond par vidéo (€)</span><input class="input num" id="set_cap" type="number" step="1" value="${config.cap}"></label></div><p class="help">S'applique à tout créateur sans barème personnalisé.</p><button class="btn primary sm" data-action="save-settings">Enregistrer le barème</button></div></div>
  <div class="panel"><div class="panel-h"><h2>Cycle de paiement</h2></div><div class="panel-b" style="padding:18px"><div class="grid3"><label class="field"><span>Fenêtre — du</span><input class="input num" id="set_open" type="number" min="1" max="31" value="${config.declareOpen}"></label><label class="field"><span>au</span><input class="input num" id="set_close" type="number" min="1" max="31" value="${config.declareClose}"></label><label class="field"><span>Paiement le</span><input class="input num" id="set_pay" type="number" min="1" max="31" value="${config.payDay}"></label></div><label style="display:flex;align-items:center;gap:9px;font-size:13.5px;margin:6px 0 12px"><input type="checkbox" id="set_force" ${config.windowForce?'checked':''}> Forcer la fenêtre ouverte (cet appareil)</label><button class="btn primary sm" data-action="save-cycle">Enregistrer le cycle</button></div></div>
  <div class="panel"><div class="panel-h"><h2>Connecteur YouTube ${ytReady?'<span class="badge b-validated" style="margin-left:8px">actif</span>':'<span class="badge b-declared" style="margin-left:8px">à configurer</span>'}</h2></div><div class="panel-b" style="padding:18px"><label class="field"><span>Clé API YouTube Data v3 <span class="muted">(stockée sur cet appareil)</span></span><input class="input" id="set_ytkey" value="${esc(config.ytKey||'')}" placeholder="AIza…"></label><p class="help">Gratuit via Google Cloud Console. YouTube est alors relevé et validé automatiquement.</p><button class="btn sm" data-action="save-ytkey">Enregistrer la clé</button></div></div>
  <div class="panel"><div class="panel-h"><h2>Instagram / TikTok</h2></div><div class="panel-b" style="padding:18px"><p class="help" style="margin-top:0">Pas de relevé automatique sans backend dédié (OAuth du compte créateur ou API tierce payante). En attendant, le créateur déclare ses vues pendant la fenêtre, tu valides.</p></div></div>`;}

/* ----------------------------- CREATOR ----------------------------- */
function renderCreator(){const c=creators[0];if(!c){return renderAuth();}const s=creatorStats(c);const w=windowInfo();
  let banner = w.open
    ? `<div class="banner open"><div class="dotpulse"></div><div><b>Fenêtre ouverte${w.forced?'':` jusqu'au ${w.cl}`}.</b> Mets à jour le total de vues de chaque vidéo pour être payé le ${w.p}.${s.todo?` Il te reste ${s.todo} vidéo(s) à déclarer.`:' Tout est déclaré ✓'}</div></div>`
    : `<div class="banner closed"><div><b>Fenêtre fermée.</b> Prochaine déclaration ${w.next}. Hors fenêtre, ta mise à jour comptera pour le mois suivant.</div></div>`;
  app().innerHTML=topbar(c.name,'Créateur',false)+`<div class="wrap">${banner}
    <div class="kpis">${kpi('À recevoir',eur(s.due),'validé, pas encore versé',true)}${kpi('Déjà reçu',eur(s.paid),'cumul')}${kpi('Gains cumulés',eur(s.earned),'depuis le début')}${kpi('Mes vues',numfmt(s.views),`${s.count} vidéo(s)`)}</div>
    <div class="banner closed" style="background:none;border-color:var(--line)"><div>Barème : <b>${rateFor(c)} €</b> / 1000 vues · plafond <b>${capFor(c)} €</b> par vidéo. Payé chaque mois sur les vues gagnées dans le mois, après validation.</div></div>
    ${creatorCharts(c)}
    <div class="panel"><div class="panel-h"><h2>Mes vidéos</h2><div class="spacer"></div><button class="btn primary sm" data-action="new-video">+ Ajouter une vidéo</button></div><div class="panel-b">${creatorVideos(c,s,w)}</div></div></div>`;}
function creatorVideos(c,s,w){
  if(!s.vids.length)return `<div class="empty"><h3>Aucune vidéo</h3><p>Ajoute le lien d'une vidéo (TikTok, Instagram, YouTube…), choisis son angle, et déclare ses vues pendant la fenêtre.</p><div style="margin-top:16px"><button class="btn primary" data-action="new-video">Ajouter une vidéo</button></div></div>`;
  const rows=s.vids.map(v=>{const p=PLATFORMS[v.platform]||PLATFORMS.autre;const st=cycleStatus(v);
    const stb=st==='validated'?'<span class="badge b-validated">validé</span>':st==='declared'?'<span class="badge b-declared">déclaré</span>':'<span class="badge b-todo">à déclarer</span>';
    const canDeclare=w.open&&st!=='validated';
    return `<tr class="row"><td><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${esc(v.title||'Vidéo')} ${angleChip(v.angle)}</div><div class="h muted"><a href="${esc(v.url)}" target="_blank" rel="noopener">${p.name} ↗</a></div></td><td class="r num">${numfmt(vDisplayViews(v))}</td><td class="r num">${eur(vTotalPay(v,c))}${vCapped(v,c)?' <span class="badge b-cap">plafond</span>':''}</td><td class="r num" style="font-weight:600;color:${vDue(v,c)>0.001?'var(--jade-2)':'var(--mist)'}">${eur(vDue(v,c))}</td><td class="r">${stb}</td><td class="r"><div class="rowbtns">${canDeclare?`<button class="btn sm primary" data-action="declare" data-id="${v.id}">${st==='declared'?'Modifier':'Déclarer'}</button>`:''}<button class="btn sm ghost" data-action="creator-vdetail" data-id="${v.id}">Détail</button></div></td></tr>`;}).join('');
  return `<div class="tscroll"><table><thead><tr><th>Vidéo</th><th class="r">Vues</th><th class="r">Gains</th><th class="r">À recevoir</th><th class="r">Ce mois</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;}

/* ----------------------------- modales ----------------------------- */
function openModal(html){const bg=document.createElement('div');bg.className='modal-bg';bg.id='modalbg';bg.innerHTML=`<div class="modal">${html}</div>`;document.body.appendChild(bg);
  bg.addEventListener('mousedown',e=>{if(e.target===bg)closeModal();});document.addEventListener('keydown',escClose);const f=bg.querySelector('input,select,button');if(f)f.focus();}
function escClose(e){if(e.key==='Escape')closeModal();}
function closeModal(){const m=document.getElementById('modalbg');if(m)m.remove();document.removeEventListener('keydown',escClose);}

function inviteModal(){const link=location.href.split('#')[0];
  openModal(`<h2>Inviter un créateur</h2><p class="msub">Pas de création manuelle : le créateur s'inscrit lui-même, tu l'actives ensuite.</p>
    <ol style="font-size:14px;color:var(--paper);padding-left:18px;line-height:1.7"><li>Envoie-lui ce lien : <br><span class="num" style="font-size:12px;word-break:break-all;color:var(--jade-2)">${esc(link)}</span></li><li>Il clique « Créer un compte » et choisit email + mot de passe.</li><li>Il apparaît ici en « en attente » → tu cliques « Activer » et règles son barème.</li></ol>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Fermer</button><button class="btn primary" data-action="copy-link" data-link="${esc(link)}">Copier le lien</button></div>`);}

function creatorEditModal(c){
  openModal(`<h2>Barème · ${esc(c.name)}</h2><p class="msub">Laisse vide pour utiliser le barème par défaut (${config.rpmRate} €/1k, plafond ${config.cap} €).</p>
    <label class="field"><span>Nom affiché</span><input class="input" id="c_name" value="${esc(c.name||'')}"></label>
    <label class="field"><span>Pseudo / handle</span><input class="input" id="c_handle" value="${esc(c.handle||'')}" placeholder="@…"></label>
    <div class="grid2"><label class="field"><span>RPM perso (€/1k)</span><input class="input num" id="c_rate" type="number" step="0.1" value="${c.rate!=null?c.rate:''}" placeholder="${config.rpmRate}"></label><label class="field"><span>Plafond perso (€)</span><input class="input num" id="c_cap" type="number" step="1" value="${c.cap!=null?c.cap:''}" placeholder="${config.cap}"></label></div>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Annuler</button><button class="btn primary" data-action="save-creator" data-id="${c.id}">Enregistrer</button></div>`);}

function videoModal(v){const e=!!v;v=v||{};const opts=Object.entries(PLATFORMS).map(([k,p])=>`<option value="${k}" ${v.platform===k?'selected':''}>${p.name}</option>`).join('');
  const aopts=ANGLES.map(a=>`<option value="${a.code}" ${v.angle===a.code?'selected':''}>${a.code} · ${a.name}</option>`).join('');
  openModal(`<h2>${e?'Modifier la vidéo':'Ajouter une vidéo'}</h2><p class="msub">Colle le lien, choisis l'angle et décris la vidéo en une phrase. Un seul angle par vidéo.</p>
    <label class="field"><span>Plateforme</span><select class="input" id="v_plat">${opts}</select></label>
    <label class="field"><span>Lien de la vidéo</span><input class="input" id="v_url" value="${esc(v.url||'')}" placeholder="https://…"></label>
    <label class="field"><span>Angle de la vidéo <span class="muted">(obligatoire)</span></span><select class="input" id="v_angle"><option value="">— choisir un angle —</option>${aopts}</select></label>
    <label class="field"><span>Titre <span class="muted">(facultatif)</span></span><input class="input" id="v_title" value="${esc(v.title||'')}" placeholder="ex. Krach 2008 — survivrais-tu ?"></label>
    <label class="field"><span>Mini-description <span class="muted">(obligatoire)</span></span><textarea class="input" id="v_note" rows="2" placeholder="ex. Hook simulateur : on rejoue le krach de 2008 en 3 décisions">${esc(v.note||'')}</textarea></label>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Annuler</button><button class="btn primary" data-action="save-video" data-id="${e?v.id:''}">${e?'Enregistrer':'Ajouter'}</button></div>`);}

function declareModal(v){const c=creators[0]||{};const m=nowMonth();const r=rdg(v,m);const cur=r?(r.declared!=null?r.declared:''):'';
  const prevV=validatedMonths(v).filter(x=>x<m);const prevViews=prevV.length?valViews(v,prevV[prevV.length-1]):0;
  openModal(`<h2>Déclarer mes vues · ${monthLabel(m)}</h2><p class="msub">${esc(v.title||'Vidéo')} — ${(PLATFORMS[v.platform]||PLATFORMS.autre).name}. Indique le total de vues affiché aujourd'hui (cumul depuis la publication).</p>
    ${prevViews?`<div class="banner closed" style="margin:0 0 14px"><div>Dernier total validé : <b style="color:var(--paper)" class="num">${numfmt(prevViews)}</b> vues.</div></div>`:''}
    <label class="field"><span>Total de vues actuel</span><input class="input num" id="dc_views" type="number" min="0" value="${cur}" placeholder="ex. 5000"></label>
    <p class="help" id="dc_preview"></p>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Annuler</button><button class="btn primary" data-action="save-declare" data-id="${v.id}">Envoyer la déclaration</button></div>`);
  const inp=document.getElementById('dc_views'),pr=document.getElementById('dc_preview');
  const upd=()=>{const x=Number(inp.value)||0;pr.innerHTML=`Gain estimé ce mois : <b>${eur(monthIncPreview(x,v,c,m))}</b> (sous réserve de validation).`;};
  inp.addEventListener('input',upd);upd();}

function validateModal(v){const c=creatorOf(v);const m=selMonth;const r=rdg(v,m)||{};const dv=r.declared!=null?r.declared:(r.validated!=null?r.validated:'');
  const isYT=v.platform==='youtube'&&ytId(v.url);
  openModal(`<h2>Valider · ${monthLabel(m)}</h2><p class="msub">${esc(v.title||'Vidéo')} — ${(PLATFORMS[v.platform]||PLATFORMS.autre).name}. Confirme le total de vues retenu.</p>
    <div class="banner closed" style="margin:0 0 14px"><div>${angleChip(v.angle)}<span style="display:block;margin-top:7px;color:var(--paper)">${esc(v.note||'—')}</span></div></div>
    ${r.declared!=null?`<div class="banner closed" style="margin:0 0 14px"><div>Déclaré : <b style="color:var(--paper)" class="num">${numfmt(r.declared)}</b> vues</div></div>`:''}
    <label class="field"><span>Total de vues validé (cumul)</span><input class="input num" id="vl_views" type="number" min="0" value="${dv}"></label>
    ${isYT?`<button class="btn sm" data-action="yt-check" data-id="${v.id}" style="margin:-6px 0 12px">Vérifier via API YouTube</button>`:''}
    <p class="help" id="vl_preview"></p>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Annuler</button><button class="btn primary" data-action="confirm-validate" data-id="${v.id}">Valider le montant</button></div>`);
  const inp=document.getElementById('vl_views'),pr=document.getElementById('vl_preview');
  const upd=()=>{const x=Number(inp.value)||0;pr.innerHTML=`Gain validé : <b>${eur(monthIncPreview(x,v,c,m))}</b>${x/1000*rateFor(c)>=capFor(c)-0.0001?' · plafond atteint':''}`;};
  inp.addEventListener('input',upd);upd();}

function creatorVDetail(v){const c=creatorOf(v);const inc=vIncrements(v,c);const ms=allMonths(v);
  const rows=ms.length?ms.map(m=>{const r=rdg(v,m);const paid=v.payments&&v.payments[m];const stt=r.status==='validated'?(paid?'<span class="badge b-paid">Reçu</span>':'<span class="badge b-due">À recevoir</span>'):'<span class="badge b-declared">En validation</span>';return `<tr class="row"><td>${monthLabel(m)}</td><td class="r num">${numfmt(r.status==='validated'?r.validated:r.declared)}</td><td class="r num">${r.status==='validated'?eur(inc[m]||0):'—'}</td><td class="r">${stt}</td></tr>`;}).join(''):'<tr><td colspan="4" class="muted" style="text-align:center;padding:18px">Pas encore de déclaration.</td></tr>';
  openModal(`<h2>${esc(v.title||'Vidéo')}</h2><p class="msub">${(PLATFORMS[v.platform]||PLATFORMS.autre).name} · ${rateFor(c)} €/1k · plafond ${capFor(c)} €</p>
    <div class="banner closed" style="margin:0 0 14px"><div>${angleChip(v.angle)}<span style="display:block;margin-top:7px;color:var(--paper)">${esc(v.note||'—')}</span></div></div>
    <div class="kpis" style="margin-bottom:16px">${kpi('À recevoir',eur(vDue(v,c)),'',true)}${kpi('Total gagné',eur(vTotalPay(v,c)),'')}</div>
    <div class="tscroll" style="border:1px solid var(--line);border-radius:10px"><table style="min-width:0"><thead><tr><th>Mois</th><th class="r">Vues (cumul)</th><th class="r">Gain</th><th class="r">Statut</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Fermer</button></div>`);}

function creatorDetailAdmin(id){const c=creators.find(x=>x.id===id);if(!c)return;const s=creatorStats(c);
  const rows=s.vids.length?s.vids.map(v=>`<tr class="row"><td><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${esc(v.title||'Vidéo')} ${angleChip(v.angle)}</div><div class="h muted">${(PLATFORMS[v.platform]||PLATFORMS.autre).name}</div></td><td class="r num">${numfmt(vDisplayViews(v))}</td><td class="r num">${eur(vTotalPay(v,c))}</td><td class="r num">${eur(vPaid(v,c))}</td><td class="r num">${eur(vDue(v,c))}</td></tr>`).join(''):'<tr><td colspan="5" class="muted" style="text-align:center;padding:18px">Aucune vidéo</td></tr>';
  openModal(`<h2>${esc(c.name)}</h2><p class="msub">${c.approved?'Actif':'En attente d\'activation'} · ${rateFor(c)} €/1k · plafond ${capFor(c)} €</p>
    <div class="kpis" style="margin-bottom:16px">${kpi('Solde dû',eur(s.due),'',true)}${kpi('Payé',eur(s.paid),'')}</div>
    <div class="tscroll" style="border:1px solid var(--line);border-radius:10px"><table style="min-width:0"><thead><tr><th>Vidéo</th><th class="r">Vues</th><th class="r">Gains</th><th class="r">Payé</th><th class="r">Dû</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="modal-foot"><button class="btn ghost" data-action="close">Fermer</button><button class="btn primary" data-action="pay-all" data-id="${c.id}" ${s.due>0.001?'':'disabled'}>Marquer ${eur(s.due)} payé</button></div>`);}

/* ===================================================================
   ACTIONS
   =================================================================== */
async function doLogin(){const email=val('lg_email'),pw=val('lg_pw');if(!email||!pw)return authErr('loginErr','Email et mot de passe requis');
  const {error}=await sb.auth.signInWithPassword({email,password:pw});if(error)return authErr('loginErr',error.message);}
async function doSignup(){const name=val('su_name'),email=val('su_email'),pw=val('su_pw');if(!name)return authErr('signupErr','Indique ton nom');if(!email||!pw)return authErr('signupErr','Email et mot de passe requis');
  const {data,error}=await sb.auth.signUp({email,password:pw,options:{data:{name}}});if(error)return authErr('signupErr',error.message);
  if(!data.session){toast('Compte créé — vérifie ta boîte mail pour confirmer.');authMode='login';renderAuth();}}
async function logout(){await sb.auth.signOut();session=null;authMode='login';renderAuth();}

async function saveCreator(id){const c=creators.find(x=>x.id===id);if(!c)return;
  const name=val('c_name'),handle=val('c_handle'),rv=val('c_rate'),cv=val('c_cap');
  const {error}=await sb.from('profiles').update({name,handle,rate:rv===''?null:Number(rv),cap:cv===''?null:Number(cv)}).eq('id',id);
  if(error)return toast('Erreur : '+error.message);closeModal();await loadAll();toast('Barème enregistré');renderAdmin();}
async function approveCreator(id){const {error}=await sb.from('profiles').update({approved:true}).eq('id',id);if(error)return toast('Erreur : '+error.message);await loadAll();toast('Créateur activé');renderAdmin();}

async function saveVideo(id){const url=val('v_url'),platform=document.getElementById('v_plat').value,title=val('v_title'),angle=document.getElementById('v_angle').value,note=val('v_note');
  if(!url)return toast('Colle le lien de la vidéo');if(!angle)return toast('Choisis l’angle de la vidéo');if(!note)return toast('Ajoute une mini-description');
  let error;
  if(id){({error}=await sb.from('videos').update({url,platform,title,angle,note}).eq('id',id));}
  else {({error}=await sb.from('videos').insert({creator_id:session.user.id,url,platform,title,angle,note}));}
  if(error)return toast('Erreur : '+error.message);closeModal();await loadAll();toast(id?'Vidéo mise à jour':'Vidéo ajoutée');render();}

async function saveDeclare(id){const v=videos.find(x=>x.id===id);if(!v)return;const w=windowInfo();if(!w.open)return toast('La fenêtre est fermée');
  const views=parseInt(val('dc_views'),10);if(isNaN(views)||views<0)return toast('Nombre de vues invalide');
  const {error}=await sb.rpc('declare_views',{p_video:id,p_month:nowMonth(),p_views:views});
  if(error)return toast('Erreur : '+error.message);closeModal();await loadAll();toast('Déclaration envoyée');render();}

async function confirmValidate(id){const views=parseInt(val('vl_views'),10);if(isNaN(views)||views<0)return toast('Nombre de vues invalide');
  const {error}=await sb.rpc('validate_reading',{p_video:id,p_month:selMonth,p_views:views});
  if(error)return toast('Erreur : '+error.message);closeModal();await loadAll();toast('Montant validé');renderAdminTab();}

async function payAll(id){const c=creators.find(x=>x.id===id);if(!c)return;const s=creatorStats(c);if(s.due<=0.001)return;
  if(!confirm(`Marquer ${eur(s.due)} comme payé à ${c.name} ?`))return;
  const {error}=await sb.rpc('mark_creator_paid',{p_creator:id});if(error)return toast('Erreur : '+error.message);
  closeModal();await loadAll();toast(`${eur(s.due)} marqué payé`);renderAdmin();}

async function ytCheck(id){const v=videos.find(x=>x.id===id);if(!v)return;const key=(config.ytKey||'').trim();const yid=ytId(v.url);
  if(!key)return toast('Ajoute une clé API YouTube dans Réglages');if(!yid)return toast('Lien YouTube non reconnu');
  try{const u='https://www.googleapis.com/youtube/v3/videos?part=statistics&id='+yid+'&fields=items(statistics(viewCount))&key='+encodeURIComponent(key);
    const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();const n=Number((d.items&&d.items[0]&&d.items[0].statistics&&d.items[0].statistics.viewCount)||0);
    const inp=document.getElementById('vl_views');if(inp){inp.value=n;inp.dispatchEvent(new Event('input'));}toast('Vues YouTube : '+numfmt(n));
  }catch(e){toast('Échec API YouTube (clé, quota ou réseau)');console.error(e);}}
async function ytPull(){const key=(config.ytKey||'').trim();if(!key)return toast('Ajoute une clé API YouTube dans Réglages');
  const list=videos.filter(v=>v.platform==='youtube'&&ytId(v.url));if(!list.length)return toast('Aucune vidéo YouTube valide');toast('Relève YouTube en cours…');
  try{const ids=list.map(v=>ytId(v.url));const map={};
    for(let i=0;i<ids.length;i+=50){const b=ids.slice(i,i+50);const u='https://www.googleapis.com/youtube/v3/videos?part=statistics&id='+b.join(',')+'&fields=items(id,statistics(viewCount))&key='+encodeURIComponent(key);
      const r=await fetch(u);if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();(d.items||[]).forEach(it=>{map[it.id]=Number((it.statistics&&it.statistics.viewCount)||0);});}
    let n=0;for(const v of list){const id=ytId(v.url);if(map[id]!=null){const {error}=await sb.rpc('validate_reading',{p_video:v.id,p_month:selMonth,p_views:map[id]});if(!error)n++;}}
    await loadAll();toast(`${n} vidéo(s) YouTube relevée(s) pour ${monthLabel(selMonth)}`);renderAdminTab();
  }catch(e){toast('Échec de la relève (clé, quota ou réseau)');console.error(e);}}

async function toggleWindow(){LP.force=!LP.force;config.windowForce=LP.force;toast(LP.force?'Fenêtre ouverte (cet appareil)':'Fenêtre rendue au calendrier');renderAdminTab();}
function copyReminder(){const w=windowInfo();const msg=`Salut ! La fenêtre de déclaration Pecunia est ouverte jusqu'au ${w.cl}. Connecte-toi et mets à jour le nombre de vues de tes vidéos avant cette date pour être payé le ${w.p}. Passé le ${w.cl}, ta mise à jour comptera pour le mois prochain. Merci !`;
  navigator.clipboard.writeText(msg).then(()=>toast('Message de rappel copié')).catch(()=>toast(msg));}
async function saveSettings(){const rate=parseFloat(val('set_rate')),cap=parseFloat(val('set_cap'));
  const {error}=await sb.from('app_config').update({rpm_rate:isNaN(rate)?config.rpmRate:rate,cap:isNaN(cap)?config.cap:cap}).eq('id',1);
  if(error)return toast('Erreur : '+error.message);await loadAll();toast('Barème enregistré');renderAdminTab();}
async function saveCycle(){const o=parseInt(val('set_open'),10),cl=parseInt(val('set_close'),10),p=parseInt(val('set_pay'),10);LP.force=document.getElementById('set_force').checked;
  const {error}=await sb.from('app_config').update({declare_open:o||config.declareOpen,declare_close:cl||config.declareClose,pay_day:p||config.payDay}).eq('id',1);
  if(error)return toast('Erreur : '+error.message);await loadAll();toast('Cycle enregistré');renderAdminTab();}
function saveYtKey(){LP.ytKey=val('set_ytkey');config.ytKey=LP.ytKey;toast(LP.ytKey?'Clé YouTube enregistrée':'Clé retirée');renderAdminTab();}

/* ----------------------------- routage clics ----------------------------- */
document.addEventListener('click',async e=>{
  const tab=e.target.closest('[data-tab]');if(tab){adminTab=tab.dataset.tab;document.querySelectorAll('.tab').forEach(t=>t.setAttribute('aria-selected',t.dataset.tab===adminTab));renderAdminTab();return;}
  const el=e.target.closest('[data-action]');if(!el)return;
  const a=el.dataset.action,id=el.dataset.id;
  if(a==='to-signup'){e.preventDefault();authMode='signup';return renderAuth();}
  if(a==='to-login'){e.preventDefault();authMode='login';return renderAuth();}
  if(a==='login-go')return doLogin();
  if(a==='signup-go')return doSignup();
  if(a==='logout')return logout();
  if(a==='close')return closeModal();
  if(a==='invite-creator')return inviteModal();
  if(a==='copy-link'){try{await navigator.clipboard.writeText(el.dataset.link);toast('Lien copié');}catch(_){toast(el.dataset.link);}return;}
  if(a==='approve')return approveCreator(id);
  if(a==='edit-creator')return creatorEditModal(creators.find(c=>c.id===id));
  if(a==='save-creator')return saveCreator(id);
  if(a==='open-creator')return creatorDetailAdmin(id);
  if(a==='new-video')return videoModal(null);
  if(a==='save-video')return saveVideo(id||null);
  if(a==='declare')return declareModal(videos.find(v=>v.id===id));
  if(a==='save-declare')return saveDeclare(id);
  if(a==='validate')return validateModal(videos.find(v=>v.id===id));
  if(a==='confirm-validate')return confirmValidate(id);
  if(a==='yt-check')return ytCheck(id);
  if(a==='yt-pull')return ytPull();
  if(a==='creator-vdetail')return creatorVDetail(videos.find(v=>v.id===id));
  if(a==='pay-all')return payAll(id);
  if(a==='toggle-window')return toggleWindow();
  if(a==='copy-reminder')return copyReminder();
  if(a==='save-settings')return saveSettings();
  if(a==='save-cycle')return saveCycle();
  if(a==='save-ytkey')return saveYtKey();
});

/* ===================================================================
   AMORÇAGE
   =================================================================== */
async function onSession(s){
  if(!s){session=null;return renderAuth();}
  const {data:prof}=await sb.from('profiles').select('*').eq('id',s.user.id).maybeSingle();
  session={user:s.user,profile:prof||{id:s.user.id,name:s.user.email,role:'creator',approved:false},role:(prof&&prof.role)||'creator'};
  try{await loadAll();}catch(e){console.error(e);}
  render();
}
(async function(){
  if(!sb || !cfg.url || cfg.url.indexOf('VOTRE-PROJET')>=0){ return renderConfigError(); }
  const {data:{session:s}}=await sb.auth.getSession();
  await onSession(s);
  sb.auth.onAuthStateChange((_e,s2)=>{ onSession(s2); });
})();
