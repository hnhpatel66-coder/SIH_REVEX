/* REVEX 3D touch: pointer tilt with light glare. Visual only. */
(function(){
  if(!window.matchMedia('(hover:hover) and (pointer:fine)').matches||window.matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  var SEL='.feature-card,.rvx-card,.visual-shell',MAX=7,cur=null,raf=0,ev=null;
  function apply(){
    raf=0;if(!cur||!ev)return;
    var r=cur.getBoundingClientRect(),x=(ev.clientX-r.left)/r.width,y=(ev.clientY-r.top)/r.height;
    cur.style.setProperty('--ry',((x-.5)*MAX*2).toFixed(2)+'deg');
    cur.style.setProperty('--rx',((.5-y)*MAX*2).toFixed(2)+'deg');
    cur.style.setProperty('--gx',(x*100).toFixed(1)+'%');
    cur.style.setProperty('--gy',(y*100).toFixed(1)+'%');
  }
  function reset(el){
    el.removeAttribute('data-tilting');
    ['--rx','--ry'].forEach(function(p){el.style.setProperty(p,'0deg')});
  }
  document.addEventListener('pointermove',function(e){
    var t=e.target.closest&&e.target.closest(SEL);
    if(t!==cur){if(cur)reset(cur);cur=t;if(cur)cur.setAttribute('data-tilting','')}
    if(!cur)return;
    ev=e;if(!raf)raf=requestAnimationFrame(apply);
  },{passive:true});
  document.addEventListener('pointerleave',function(){if(cur){reset(cur);cur=null}},true);
  /* hero parallax: visual drifts gently with the pointer */
  var hv=document.querySelector('.hero-visual');
  if(hv)document.addEventListener('pointermove',function(e){
    var x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5;
    hv.style.transform='translate3d('+(x*-10).toFixed(1)+'px,'+(y*-8).toFixed(1)+'px,0)';
  },{passive:true});
})();
