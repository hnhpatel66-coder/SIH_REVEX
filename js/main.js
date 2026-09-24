const API_BASE = '/api';
const BRAND = 'REVEX';
function formatDate(value){try{return new Date(value).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}catch{return value}}
function readStored(key){ try{return localStorage.getItem(key)}catch{return null} }
function getStoredUser(){
  try{
    const raw = localStorage.getItem('revexUser') || localStorage.getItem('vroomyUser') || 'null';
    return JSON.parse(raw);
  }catch{return null}
}
function getToken(){ return readStored('revexToken') || readStored('vroomyToken') || ''; }
function friendlyError(message, status){
  const m = String(message||'');
  if(/cast.*objectid|invalid.*object\s?id|invalid vehicle id|invalid booking id|invalid ride/i.test(m)) return 'We could not find that item. Please try again.';
  if(/jwt|token|session|unauthorized|login required|expired/i.test(m) && status!==403) return 'Your session has expired. Please log in again.';
  if(/mongo|database|server selection|timed out|network/i.test(m)) return 'Something went wrong while loading your data. Please try again.';
  if(/api endpoint/i.test(m)) return 'Request not found.';
  return m || 'Something went wrong. Please try again.';
}
async function api(path, options={}) {
  const headers = {...(options.headers||{})};
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type']='application/json';
  const token=getToken(); if(token) headers.Authorization='Bearer '+token;
  let res;
  try{res=await fetch(API_BASE+path,{...options,headers})}
  catch(error){throw new Error('Cannot reach the '+BRAND+' service. Please check your connection and try again.')}
  let data={}; try{data=await res.json()}catch{}
  if(!res.ok) {
    throw new Error(friendlyError(data.message, res.status));
  }
  return data;
}
function setSession(data){
  localStorage.setItem('revexToken',data.token);
  localStorage.setItem('revexUser',JSON.stringify(data.user));
  try{localStorage.removeItem('vroomyToken');localStorage.removeItem('vroomyUser');}catch{}
}
function clearSession(){try{localStorage.removeItem('revexToken');localStorage.removeItem('revexUser');localStorage.removeItem('vroomyToken');localStorage.removeItem('vroomyUser');}catch{}}
function requireLogin(){if(!getToken()){window.location.href='login.html';return false}return true}
function showModal(title,message){const modal=document.getElementById('successModal');if(!modal)return;modal.querySelector('h2').textContent=title;modal.querySelector('p').textContent=message;modal.classList.add('show')}
function closeModal(){document.getElementById('successModal')?.classList.remove('show')}

/* Role-based navigation: each role sees only its own tabs. Admin pages use their own topbar.
   Auth links (Log in / Join) live ONLY in the action area, never as tabs. */
const NAV_CONFIG = {
  guest: [
    {href:'index.html',label:'Home'},
    {href:'find-ride.html',label:'Find a Ride'},
    {href:'rental.html',label:'Rent a Vehicle'},
    {href:'offer-ride.html',label:'Offer a Ride'}
  ],
  user: [
    {href:'index.html',label:'Home'},
    {href:'rental.html',label:'Find Vehicles'},
    {href:'find-ride.html',label:'Find a Ride'},
    {href:'bookings.html',label:'My Bookings'},
    {href:'profile.html',label:'Profile'}
  ],
  owner: [
    {href:'list-vehicle.html',label:'Dashboard'},
    {href:'list-vehicle.html#fleet',label:'Listed Vehicles'},
    {href:'list-vehicle.html#add',label:'Add Vehicle'},
    {href:'bookings.html',label:'Bookings'},
    {href:'list-vehicle.html#earnings',label:'Income'},
    {href:'profile.html',label:'Profile'}
  ],
  adminLite: [
    {href:'admin.html',label:'Admin Dashboard'},
    {href:'profile.html',label:'Profile'}
  ]
};

function currentPage(){ const p=(location.pathname.split('/').pop()||'index.html').split('#')[0]; return p||'index.html'; }
function currentHash(){ return location.hash||''; }

document.addEventListener('DOMContentLoaded',()=>{
  const user=getStoredUser();
  const role=user?.role||'guest';
  const isAdminPage=location.pathname.endsWith('admin.html');
  if(isAdminPage){
    // Admin has its own dedicated navigation; never mix role tabs here.
    if(role!=='admin'){window.location.replace('login.html');return;}
    bindMenu();
    applyBrand();
    const exitAdmin=document.querySelector('[data-exit-admin]');
    exitAdmin?.addEventListener('click',()=>clearSession());
    return;
  }
  if(role==='admin' && !isAdminPage){
    // Admins stay in the admin portal, except their profile page which is allowed.
    if(currentPage()==='profile.html'){ buildNav('adminLite', user); bindMenu(); applyBrand(); return; }
    window.location.replace('admin.html');return;
  }
  buildNav(role, user);
  bindMenu();
  applyBrand();
});

function buildNav(role, user){
  const links=document.querySelector('.nav-links');
  if(links){
    const items=NAV_CONFIG[role]||NAV_CONFIG.guest;
    links.replaceChildren();
    const page=currentPage(), hash=currentHash();
    const full=page+hash;
    // Exact href match wins so only one tab is ever highlighted;
    // otherwise fall back to the base page tab.
    let activeHref=items.some(o=>o.href===full)?full:page;
    for(const it of items){
      const a=document.createElement('a');
      a.href=it.href; a.textContent=it.label;
      if(it.cta)a.className='btn btn-primary';
      if(it.href===activeHref)a.classList.add('active');
      a.addEventListener('click',()=>links.classList.remove('open'));
      links.appendChild(a);
    }
  }
  const actions=document.querySelector('.nav-actions');
  if(actions){
    actions.replaceChildren();
    if(user){
      const profile=document.createElement('a');
      profile.href='profile.html';
      profile.className='user-nav';
      const avatar=document.createElement('span');
      avatar.className='user-avatar';
      avatar.textContent=(user.name||'R').slice(0,1).toUpperCase();
      const name=document.createElement('span');
      name.className='user-nav-name';
      name.textContent=user.name||'Account';
      profile.append(avatar,name);
      actions.appendChild(profile);
      if(role==='user'){
        const up=document.createElement('a');
        up.href='profile.html';
        up.className='btn btn-outline';
        up.textContent='Become an Owner';
        actions.appendChild(up);
      }
      if(role==='owner'){
        const down=document.createElement('a');
        down.href='profile.html';
        down.className='btn btn-outline';
        down.textContent='Switch to User';
        actions.appendChild(down);
      }
      const logout=document.createElement('a');
      logout.href='#';
      logout.className='btn btn-primary';
      logout.textContent='Logout';
      logout.onclick=e=>{e.preventDefault();clearSession();location.href='index.html'};
      actions.appendChild(logout);
    }else{
      const login=document.createElement('a');
      login.href='login.html';
      login.textContent='Log in';
      actions.appendChild(login);
      const join=document.createElement('a');
      join.href='register.html';
      join.className='btn btn-primary';
      join.textContent='Join '+BRAND;
      actions.appendChild(join);
    }
  }
}

function bindMenu(){
  const menu=document.querySelector('.menu-btn'),links=document.querySelector('.nav-links');
  if(menu&&links&&!menu.dataset.bound){
    menu.dataset.bound='1';
    menu.textContent='Menu';
    menu.setAttribute('aria-label','Open navigation');
    menu.setAttribute('aria-expanded','false');
    menu.addEventListener('click',()=>{
      const open=links.classList.toggle('open');
      menu.setAttribute('aria-expanded',open?'true':'false');
    });
    document.addEventListener('click',e=>{
      if(links.classList.contains('open')&&!e.target.closest('.nav')){links.classList.remove('open');menu.setAttribute('aria-expanded','false');}
    });
    window.addEventListener('resize',()=>{
      if(window.innerWidth>900&&links.classList.contains('open')){links.classList.remove('open');menu.setAttribute('aria-expanded','false');}
    });
  }
}

function applyBrand(){
  document.querySelectorAll('.brand').forEach(brand=>brand.innerHTML='REV<span>EX</span>');
  document.title=document.title.replaceAll('VRUMY','REVEX').replaceAll('VROOMY','REVEX').replaceAll('VROO','REV');
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  const skip=new Set(['SCRIPT','STYLE']);
  while(node=walker.nextNode()){
    if(skip.has(node.parentElement?.tagName))continue;
    node.nodeValue=node.nodeValue.replaceAll('VRUMY','REVEX').replaceAll('VROOMY','REVEX');
  }
}

async function downloadAgreement(bookingId){
  try{
    const res=await fetch(API_BASE+'/bookings/'+encodeURIComponent(bookingId)+'/agreement',{
      headers:{Authorization:'Bearer '+getToken()}
    });
    if(!res.ok){
      let d={};try{d=await res.json()}catch{}
      throw new Error(friendlyError(d.message, res.status));
    }
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download='REVEX-Agreement-'+bookingId+'.pdf';
    document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }catch(e){alert(friendlyError(e.message))}
}
