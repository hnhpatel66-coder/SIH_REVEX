function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

document.addEventListener('DOMContentLoaded',async()=>{
 const el=document.getElementById('bookingList'); if(!el||!requireLogin())return;
 let rentals=[], rides=[];
 try{ rentals=await api('/bookings/my'); }catch(e){console.error(e)}
 try{ rides=await api('/rides/bookings/my'); }catch(e){console.error(e)}

 const all=[
  ...rentals.map(x=>({...x,kind:'Rental'})),
  ...rides.map(x=>({...x,kind:'Ride'}))
 ].sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));

 const render=status=>{
  const normalized=status.toLowerCase();
  const visible=normalized==='upcoming'
    ? all.filter(x=>['pending','payment_pending','confirmed'].includes(x.status))
    : all.filter(x=>x.status===normalized);

  el.innerHTML=visible.length?visible.map(x=>{
   const isRide=x.kind==='Ride';
   const title=isRide
     ? `${esc(x.rideId?.from||'')} -&gt; ${esc(x.rideId?.to||'')}`
     : esc(x.vehicleId?.name||'Vehicle rental');
   const date=isRide ? `${formatDate(x.rideId?.date)} - ${esc(x.rideId?.time||'')}` : `${new Date(x.startDate).toLocaleString('en-IN')} - ${x.hours||1} hour(s)`;
   const canCancel=['pending','payment_pending','confirmed'].includes(x.status);
   const cancelAttr=isRide?`data-cancel-ride="${x.id}"`:`data-cancel-rental="${x.id}"`;
   const agreement=!isRide&&x.paymentStatus==='paid'
     ?`<button class="btn btn-outline" style="margin-top:8px;padding:8px 11px" data-download="${x.id}">Agreement</button> <a class="btn btn-outline" style="margin-top:8px;padding:8px 11px" href="agreement.html?bookingId=${encodeURIComponent(x.id)}">Sign / View</a>`:'';
   const canRate=(x.status==='completed'||x.status==='confirmed')&&x.paymentStatus==='paid';
   const rated=x.rating?`<br><small>Rated ${esc(x.rating)}/5${x.comment?` - &quot;${esc(x.comment)}&quot;`:''}</small>`:'';
   const rateBtn=canRate&&!x.rating
     ?`<br><button class="btn btn-outline" style="margin-top:8px;padding:8px 11px" data-rate="${x.id}" data-kind="${x.kind}">Rate ${x.kind}</button>`:'';
   return `<article class="booking-row">
    <div><span class="pill">${x.kind} - ${esc(x.paymentStatus||'pending')}</span>
     <h3 style="margin:8px 0 4px">${title}</h3>
     <span class="card-meta">${date}</span>${rated}
    </div>
    <div style="text-align:right"><b>Rs.${Number(x.totalAmount||0).toLocaleString('en-IN')}</b><br>
      <span class="status">${esc(x.status)}</span>
      ${canCancel?`<br><button class="btn btn-outline" style="margin-top:8px;padding:8px 11px" ${cancelAttr}>Cancel booking</button>`:''}
      ${agreement}${rateBtn}
    </div>
   </article>`;
  }).join(''):`<div class="empty">No ${normalized} bookings yet.</div>`;
 };

 render('Upcoming');
 document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{
   document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
   tab.classList.add('active'); render(tab.textContent);
 }));

 el.addEventListener('click',async e=>{
  const download=e.target.closest('[data-download]');
  if(download){downloadAgreement(download.dataset.download);return;}

  const rate=e.target.closest('[data-rate]');
  if(rate){
    const rating=Number(prompt('Rate this '+rate.dataset.kind+' from 1 to 5:'));
    if(!rating||rating<1||rating>5){alert('Rating must be between 1 and 5.');return;}
    const comment=prompt('Optional comment (max 500 chars):')||'';
    try{
      const endpoint=rate.dataset.kind==='Ride'
        ?'/rides/bookings/'+encodeURIComponent(rate.dataset.rate)+'/feedback'
        :'/bookings/'+encodeURIComponent(rate.dataset.rate)+'/feedback';
      await api(endpoint,{method:'POST',body:JSON.stringify({rating,comment})});
      alert('Feedback saved. It now shows on your profile and the admin dashboard.');
      location.reload();
    }catch(err){alert(err.message)}
    return;
  }

  const rental=e.target.closest('[data-cancel-rental]');
  const ride=e.target.closest('[data-cancel-ride]');
  if(!rental&&!ride)return;
  if(!confirm('Cancel this booking?'))return;
  try{
    const endpoint=rental
      ?'/bookings/'+encodeURIComponent(rental.dataset.cancelRental)+'/cancel'
      :'/rides/bookings/'+encodeURIComponent(ride.dataset.cancelRide)+'/cancel';
    await api(endpoint,{method:'POST'});
    const updatedRental=await api('/bookings/my'); rentals=updatedRental;
    try{rides=await api('/rides/bookings/my')}catch{}
    all.length=0;
    all.push(...rentals.map(x=>({...x,kind:'Rental'})),...rides.map(x=>({...x,kind:'Ride'})));
    all.sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
    const active=document.querySelector('.tab.active')?.textContent||'Upcoming';
    render(active);
    alert('Booking cancelled successfully.');
  }catch(err){alert(err.message)}
 });

 try{
  const agreements=await api('/bookings/my-agreements');
  const ael=document.getElementById('agreementList');
  if(ael)ael.innerHTML=agreements.length?agreements.map(a=>`<article class="booking-row"><div><b>${esc(a.agreementId)}</b><br><small>Booking ${esc(a.bookingId)}</small></div><button class="btn btn-primary" data-download-agreement="${a.bookingId}">Download PDF</button></article>`).join(''):'<div class="empty">No agreements generated yet.</div>';
  ael?.addEventListener('click',e=>{const b=e.target.closest('[data-download-agreement]');if(b)downloadAgreement(b.dataset.downloadAgreement)});
 }catch(e){}
});
