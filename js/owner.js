const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function inr(n){return 'Rs.'+Number(n||0).toLocaleString('en-IN');}

async function fileToDataUrl(file){
 if(!file)return '';
 if(file.size>4*1024*1024)throw new Error('Vehicle photo must be 4 MB or smaller.');
 return await new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(reader.result);
  reader.onerror=()=>reject(new Error('Could not read vehicle photo.'));
  reader.readAsDataURL(file);
 });
}

function approvalBadge(v){
  if(v.verified) return '<span class="pill">Approved</span>';
  if(v.status==='unavailable') return '<span class="pill" style="background:rgba(251,113,133,.1);border-color:rgba(251,113,133,.3);color:#fda4af">Rejected</span>';
  return '<span class="pill" style="background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.3);color:#fcd34d">Pending Approval</span>';
}

async function renderOwnerVehicles(){
 const list=document.getElementById('ownerVehicleList');if(!list)return;
 if(!requireLogin())return;
 const current=getStoredUser();
 if(current && !['owner','admin'].includes(current.role)){
   list.innerHTML='<div class="empty">Your account is a renter account. Use Profile to switch to an owner account.</div>';
   return;
 }
 try{
  const s=await api('/bookings/owner/summary');
  const fleet=s.vehicles||[];
  list.innerHTML=fleet.length?fleet.map(v=>`<article class="vehicle-card">
    <div class="vehicle-image" style="height:175px;overflow:hidden"><img src="${v.image||''}" alt="${escapeHtml(v.name)}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'"></div>
    <div class="card-body">${approvalBadge(v)}
    <h3 class="card-title" style="margin-top:12px">${escapeHtml(v.name)}</h3>
    <div class="card-meta">${escapeHtml(v.type||'')} - ${escapeHtml(v.location||'')}</div>
    <div class="card-meta">Reg: <b>${escapeHtml(v.numberPlate||'-')}</b> - ${inr(v.price)}/hour</div>
    <div class="card-meta">Availability: ${escapeHtml(v.status||'available')} - Rating: ${escapeHtml(v.rating||5)}</div>
    <p class="card-price">${inr(v.earnings)} <small>total (${v.totalBookings||0} bookings, ${v.completedRentals||0} completed)</small></p>
    <div class="card-actions">
      <button class="btn btn-outline" type="button" data-edit-vehicle="${v.id}">Edit</button>
      <button class="btn btn-outline" type="button" data-delete-vehicle="${v.id}">Remove</button>
    </div></div></article>`).join(''):'<div class="empty">You have not listed any vehicles yet.</div>';
 }catch(e){list.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`}
}

async function renderOwnerDashboard(){
 const box=document.getElementById('ownerDashboard');if(!box)return;
 const current=getStoredUser();
 if(!current || !['owner','admin'].includes(current.role)){box.innerHTML='';return;}
 try{
  const s=await api('/bookings/owner/summary');
  document.getElementById('ownerStats').innerHTML=[
   ['Total vehicles',s.totalVehicles||0,'Listed on the platform'],
   ['Approved vehicles',s.approvedVehicles||0,'Verified listings'],
   ['Pending vehicles',s.pendingVehicles||0,'Awaiting verification'],
   ['Total bookings',s.totalBookings||0,'All rental bookings'],
   ['Completed rentals',s.completedRentals||0,'Finished trips'],
   ['Total earnings',inr(s.totalEarnings),'90% share of paid bookings'],
   ['Completed earnings',inr(s.completedEarnings),'From completed trips'],
   ['Pending earnings',inr(s.pendingPayments),`${s.pendingPaymentCount||0} payment(s) awaiting`]
  ].map(x=>`<article class="vehicle-card"><div class="card-body"><span class="eyebrow">${x[0]}</span><h2 style="font-size:2rem;margin:12px 0">${x[1]}</h2><p style="margin:0">${x[2]}</p></div></article>`).join('');

  document.getElementById('ownerRevenue').innerHTML=s.revenuePerVehicle?.length
   ? s.revenuePerVehicle.map(v=>`<p style="padding:12px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(v.vehicleName)}</b><br><small>Total: ${v.totalBookings} booking(s) - Completed: ${v.completedRentals} - Cancelled: ${v.cancelledBookings} - Earnings: ${inr(v.earnings)}</small></p>`).join('')
   : '<p>No paid bookings yet.</p>';

  document.getElementById('ownerRecent').innerHTML=s.recent?.length
   ? s.recent.map(b=>`<p style="padding:12px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(b.vehicleId?.name||'Vehicle')}</b><br><small>${escapeHtml(b.userId?.name||'Renter')} - ${inr(b.totalAmount)} - ${escapeHtml(b.paymentStatus||b.status)}</small>${b.paymentStatus==='paid'?`<br><a class="btn btn-outline" style="margin-top:7px;padding:6px 10px" href="agreement.html?bookingId=${encodeURIComponent(b.id)}">Open agreement</a>`:''}</p>`).join('')
   : '<p>No bookings yet.</p>';
 }catch(e){box.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`}
}

document.addEventListener('DOMContentLoaded',()=>{
 const form=document.getElementById('vehicleListing');
 form?.addEventListener('submit',async event=>{
  event.preventDefault(); if(!requireLogin())return;
  const current=getStoredUser();
  if(current && !['owner','admin'].includes(current.role)){alert('Please use an owner account to list a vehicle.');return;}
  const f=event.target;
  try{
   const picture=await fileToDataUrl(f.vehiclePicture?.files[0]);
   const item=await api('/vehicles',{method:'POST',body:JSON.stringify({
    name:f.name.value.trim(),type:f.type.value,location:f.location.value.trim(),price:Number(f.price.value),
    available:f.available.value,numberPlate:f.numberPlate?.value.trim()||'',
    ownershipPaper:f.ownershipPaper?.files[0]?.name||'',
    insurance:f.insurance?.files[0]?.name||'',
    puc:f.puc?.files[0]?.name||'',
    vehiclePicture:picture
   })});
   await renderOwnerVehicles();await renderOwnerDashboard();
   showModal('Vehicle listed successfully!',`${item.name} was saved. It is pending verification.`);
   f.reset();
  }catch(e){alert(e.message)}
 });
 document.getElementById('ownerVehicleList')?.addEventListener('click',async event=>{
  const del=event.target.closest('[data-delete-vehicle]');
  const edit=event.target.closest('[data-edit-vehicle]');
  if(del){
    if(!confirm('Remove this vehicle? If it has booking history it will be deactivated instead of deleted.'))return;
    try{
      const r=await api('/vehicles/'+del.dataset.deleteVehicle,{method:'DELETE'});
      await renderOwnerVehicles();await renderOwnerDashboard();
      showModal('Done',r.message||'Vehicle updated.');
    }catch(e){alert(e.message)}
    return;
  }
  if(edit){
    const price=prompt('New hourly price (Rs.):');
    if(price===null)return;
    if(!Number(price)||Number(price)<1){alert('Enter a valid price.');return;}
    const location=prompt('Pickup location:');
    if(location===null)return;
    try{
      await api('/vehicles/'+edit.dataset.editVehicle,{method:'PUT',body:JSON.stringify({price:Number(price),location:String(location).trim()||undefined})});
      await renderOwnerVehicles();
    }catch(e){alert(e.message)}
  }
 });
 renderOwnerVehicles();renderOwnerDashboard();
});
