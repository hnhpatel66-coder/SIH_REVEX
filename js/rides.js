function rideCard(r){
 const img=r.vehicleImage?`<div style="height:140px;overflow:hidden;border-radius:8px;margin-bottom:10px"><img src="${r.vehicleImage}" alt="vehicle" style="width:100%;height:100%;object-fit:cover"></div>`:'';
 return `<article class="ride-card">${img}
  <div class="card-top"><div><span class="pill">Route match</span><h3 class="ride-route">${escapeHtml(r.from)} <span style="color:#176bff">-&gt;</span> ${escapeHtml(r.to)}</h3></div><span class="rating">* ${r.rating||5}</span></div>
  <p class="card-meta">Driver: <b>${escapeHtml(r.driver)}</b>${r.driverPhone?` (${escapeHtml(r.driverPhone)})`:''} - ${escapeHtml(r.vehicle||'')}</p>
  <p class="card-meta">${escapeHtml(r.vehicleType||'Car')}${r.numberPlate?` - Plate: <b>${escapeHtml(r.numberPlate)}</b>`:''}</p>
  <div class="ride-details"><div><b>Departure</b>${formatDate(r.date)} - ${escapeHtml(r.time)}</div><div><b>Available</b>${r.seats} seats</div><div><b>Price</b>Rs.${r.price}/person</div></div>
  <div class="card-actions"><a class="btn btn-outline" href="ride-details.html?id=${encodeURIComponent(r.id)}">View ride</a><a class="btn btn-primary" href="ride-details.html?id=${encodeURIComponent(r.id)}">Book seat</a></div>
 </article>`;
}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function getRides(params={}){const p=new URLSearchParams();Object.entries(params).forEach(([k,v])=>v&&p.set(k,v));return api('/rides?'+p.toString())}
async function renderRides(list){const el=document.getElementById('rideResults');if(el)el.innerHTML=list?.length?list.map(rideCard).join(''):'<div class="empty">No matching rides. New rides appear after admin approval.</div>'}
function fileToDataUrl(file){
 return new Promise((resolve,reject)=>{
  if(!file)return resolve('');
  if(file.size>3*1024*1024)return reject(new Error('Vehicle photo must be 3 MB or smaller.'));
  const reader=new FileReader();
  reader.onload=()=>resolve(reader.result);
  reader.onerror=()=>reject(new Error('Could not read photo.'));
  reader.readAsDataURL(file);
 });
}

let currentRideId='';
document.addEventListener('DOMContentLoaded',async()=>{
 const search=document.getElementById('rideSearch');
 if(document.getElementById('rideResults')){
  try{await renderRides(await getRides())}catch(e){renderRides([])}
  search?.addEventListener('submit',async e=>{
   e.preventDefault(); const f=e.target;
   try{await renderRides(await getRides({from:f.from.value,to:f.to.value,date:f.date.value}))}
   catch(err){alert(err.message)}
  });
 }

 const offer=document.getElementById('offerRide');
 offer?.addEventListener('submit',async e=>{
  e.preventDefault(); if(!requireLogin())return;
  const f=e.target;
  try{
   const vehicleImage=await fileToDataUrl(f.vehicleImage?.files?.[0]);
   const r=await api('/rides',{method:'POST',body:JSON.stringify({
    from:f.from.value.trim(),to:f.to.value.trim(),date:f.date.value,time:f.time.value,
    seats:Number(f.seats.value),price:Number(f.price.value),vehicle:f.vehicle.value.trim(),
    vehicleType:f.vehicleType?.value||'Car',numberPlate:f.numberPlate?.value.trim()||'',
    driverPhone:f.driverPhone?.value.trim()||''
   ,vehicleImage})});
   showModal('Ride submitted!',r.message||`${r.from} to ${r.to} saved.`);
   f.reset();
  }catch(err){alert(err.message)}
 });

 const panel=document.getElementById('rideDetail');
 if(panel){
  currentRideId=new URLSearchParams(location.search).get('id');
  try{
   const list=await getRides();
   let item=list.find(x=>x.id===currentRideId);
   if(!item){
     try{ const all=await api('/rides?status=all'); item=all.find(x=>x.id===currentRideId); }catch{}
   }
   if(!item)throw new Error('Ride not found (it may be pending admin approval).');

   panel.innerHTML=`<span class="pill">${item.verified===false?'Pending approval':'Available'}</span>
   ${item.vehicleImage?`<div style="height:220px;overflow:hidden;border-radius:10px;margin:14px 0"><img src="${item.vehicleImage}" style="width:100%;height:100%;object-fit:cover"></div>`:''}
   <h1 class="section-title">${escapeHtml(item.from)} -&gt; ${escapeHtml(item.to)}</h1>
   <p>Travel with ${escapeHtml(item.driver)}${item.driverPhone?` (${escapeHtml(item.driverPhone)})`:''} in a ${escapeHtml(item.vehicle||'')} (${escapeHtml(item.vehicleType||'Car')}).</p>
   ${item.numberPlate?`<p><b>Number plate:</b> ${escapeHtml(item.numberPlate)}</p>`:''}
   <div class="ride-details"><div><b>Date</b>${formatDate(item.date)}</div><div><b>Departure</b>${escapeHtml(item.time)}</div><div><b>Seats available</b><span id="detailSeats">${item.seats}</span></div><div><b>Price</b>Rs.${item.price} per seat</div></div>`;

   document.getElementById('ridePrice').value=Number(item.price)||0;
   document.getElementById('availableSeats').textContent=item.seats;
   const select=document.getElementById('seatCount');
   const max=Math.max(1,Math.min(Number(item.seats)||1,6));
   select.innerHTML=Array.from({length:max},(_,i)=>`<option value="${i+1}">${i+1} ${i===0?'seat':'seats'}</option>`).join('');
   updateSeatTotal();
  }catch(e){panel.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`}
 }
});

function updateSeatTotal(){
 const n=Number(document.getElementById('seatCount')?.value)||1;
 const p=Number(document.getElementById('ridePrice')?.value)||0;
 const total=n*p;
 const el=document.getElementById('seatTotal'); if(el)el.textContent='Rs.'+total.toLocaleString('en-IN');
 const pay=document.getElementById('ridePayAmount'); if(pay)pay.textContent='Rs.'+total.toLocaleString('en-IN');
}

async function confirmRide(e){
 e.preventDefault();
 if(!requireLogin())return;
 if(!currentRideId){alert('Ride ID is missing.');return;}
 const seats=Number(document.getElementById('seatCount')?.value)||1;
 const total=seats*(Number(document.getElementById('ridePrice')?.value)||0);
 if(total<=0){alert('Ride price is unavailable.');return;}

 const payment=document.getElementById('paymentModal');
 const payBtn=document.getElementById('ridePayBtn');
 const cancelBtn=document.getElementById('ridePayCancel');
 const amount=document.getElementById('ridePayAmount');
 if(amount)amount.textContent='Rs.'+total.toLocaleString('en-IN');

 let booking;
 try{
   booking=await api('/rides/'+encodeURIComponent(currentRideId)+'/book',{method:'POST',body:JSON.stringify({seats})});
 }catch(err){alert(err.message);return;}

 payment?.classList.add('show');
 payBtn.onclick=async()=>{
   payBtn.disabled=true; payBtn.textContent='Processing...';
   try{
    await api('/rides/bookings/'+encodeURIComponent(booking.id)+'/payment-demo',{method:'POST'});
    payment?.classList.remove('show');
    showModal('Ride booked successfully!',`Rs.${total.toLocaleString('en-IN')} paid. Your seat is confirmed.`);
   }catch(err){alert(err.message)}
   finally{payBtn.disabled=false;payBtn.textContent='Pay Now';}
 };
 cancelBtn.onclick=async()=>{
   payment?.classList.remove('show');
   try{await api('/rides/bookings/'+encodeURIComponent(booking.id)+'/payment-failed',{method:'POST'})}catch{}
 };
}
