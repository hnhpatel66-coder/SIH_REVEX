function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function inr(n){return 'Rs.'+Number(n||0).toLocaleString('en-IN');}
document.addEventListener('DOMContentLoaded',async()=>{
 const user=getStoredUser();if(user?.role!=='admin')return;
 try{
  /* ---------- Dashboard ---------- */
  const s=await api('/admin/summary');
  const stat=(label,value,note)=>`<article class="vehicle-card"><div class="card-body"><span class="eyebrow">${label}</span><h2 style="font-size:2.1rem;margin:12px 0">${value}</h2><p style="margin:0">${note}</p></div></article>`;
  const approved=(s.vehicles||0)-(s.pendingVehicleVerification||0);
  document.getElementById('adminStats').innerHTML=
    stat('Total users',s.users,'Registered accounts')+
    stat('Total owners',s.owners,'Owner accounts')+
    stat('Total vehicles',s.vehicles,'Vehicle inventory')+
    stat('Pending approvals',s.pendingVehicleVerification,'Awaiting verification')+
    stat('Approved vehicles',approved,'Verified listings')+
    stat('Total bookings',s.bookings,'Stored rental bookings')+
    stat('Shared rides',s.rides,'Published ride offers')+
    stat('Total revenue',inr(s.totalRevenue),'Successful paid bookings');

  /* ---------- Inventory (vehicles + rides) ---------- */
  const vs=await api('/vehicles?status=all');
  const vehicleRow=v=>`<div style="padding:12px 0;border-bottom:1px solid #e5ebf4">
    <b>${escapeHtml(v.name)}</b><br><small>${escapeHtml(v.type)} - ${escapeHtml(v.location)} - Rs.${v.price}/hour - ${v.verified?'Verified':'Pending'}</small>
    ${!v.verified
 ? `<br><button class="btn btn-primary" style="margin-top:8px;padding:8px 12px" data-verify="${v.id}">Approve</button>
    <button class="btn btn-outline" style="margin-top:8px;padding:8px 12px" data-reject="${v.id}">Reject</button>`
 : `<br><span class="pill">Approved</span> <button class="btn btn-outline" style="margin-top:8px;padding:8px 12px" data-del-vehicle="${v.id}">Remove vehicle</button>`}
  </div>`;
  document.getElementById('adminVehicles').innerHTML=vs.length?vs.map(vehicleRow).join(''):'<p>No vehicles.</p>';

  const pending=vs.filter(v=>!v.verified);
  document.getElementById('adminApprovals').innerHTML=pending.length?pending.map(v=>`<div style="padding:12px 0;border-bottom:1px solid #e5ebf4">
    <b>${escapeHtml(v.name)}</b><br><small>${escapeHtml(v.type)} - ${escapeHtml(v.location)} - Rs.${v.price}/hour${v.numberPlate?` - Plate: ${escapeHtml(v.numberPlate)}`:''}</small>
    ${v.image?`<br><img src="${v.image}" style="max-width:100%;max-height:120px;border-radius:8px;margin-top:8px">`:''}
    <br><button class="btn btn-primary" style="margin-top:8px;padding:8px 12px" data-verify="${v.id}">Approve</button>
    <button class="btn btn-outline" style="margin-top:8px;padding:8px 12px" data-reject="${v.id}">Reject</button></div>`).join(''):'<p>No pending vehicle approvals.</p>';

  const rs=await api('/rides?status=all');
  const rideRow=r=>`<p style="padding:11px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(r.from)} to ${escapeHtml(r.to)}</b><br><small>${escapeHtml(r.driver)}${r.driverPhone?` (${escapeHtml(r.driverPhone)})`:''} - ${r.seats} seats - Rs.${r.price}/seat - ${escapeHtml(r.vehicleType||'Car')}${r.numberPlate?` - ${escapeHtml(r.numberPlate)}`:''} - ${r.verified?'Verified':'Pending'}</small><br>${!r.verified?`<button class="btn btn-primary" style="margin-top:6px;padding:6px 10px" data-verify-ride="${r.id}">Approve ride</button> `:''}<button class="btn btn-outline" style="margin-top:6px;padding:6px 10px" data-del-ride="${r.id}">Remove ride</button></p>`;
  document.getElementById('adminRides').innerHTML=(rs.map(rideRow).join('')||'<p>No rides.</p>');
  const pendingRides=rs.filter(r=>!r.verified);
  document.getElementById('adminRideApprovals').innerHTML=pendingRides.length?pendingRides.map(rideRow).join(''):'<p>No pending ride approvals.</p>';
  try{
    const rbs=await api('/admin/ride-bookings');
    document.getElementById('adminRides').innerHTML += rbs.length
      ? '<h4 style="margin-top:18px">Ride bookings</h4>'+rbs.map(b=>`<p style="padding:10px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(b.rideId?.from||'')} to ${escapeHtml(b.rideId?.to||'')}</b><br><small>${escapeHtml(b.userId?.name||'User')} - ${b.seats} seat(s) - ${inr(b.totalAmount)} - ${escapeHtml(b.status)}</small><br>${!['cancelled','completed'].includes(b.status)?`<button class="btn btn-outline" style="margin-top:6px;padding:6px 10px" data-ride-booking-cancel="${b.id}">Cancel booking</button>`:''}</p>`).join('')
      : '';
  }catch{}

  /* ---------- Bookings ---------- */
  const bs=await api('/admin/bookings');
  document.getElementById('adminBookings').innerHTML=bs.map(b=>`<article class="booking-row"><div>
    <span class="pill">${escapeHtml(b.paymentStatus||'pending')}</span>
    <h3 style="margin:8px 0 0">${escapeHtml(b.vehicleId?.name||'Vehicle')}</h3>
    <small>${escapeHtml(b.userId?.name||'User')} - ${b.startDate?new Date(b.startDate).toLocaleString('en-IN'):''}${b.rating?` - Rated ${b.rating}/5`:''}${b.comment?` - "${escapeHtml(b.comment)}"`:''}</small>
  </div><div style="text-align:right"><b>${inr(b.totalAmount)}</b><br><span class="status">${escapeHtml(b.status)}</span>
    ${!['cancelled','completed'].includes(b.status)?`<br><button class="btn btn-outline" style="margin-top:8px;padding:7px 10px" data-booking-action="completed" data-booking-id="${b.id}">Mark completed</button> <button class="btn btn-outline" style="margin-top:8px;padding:7px 10px" data-booking-action="cancelled" data-booking-id="${b.id}">Cancel</button>`:''}
  </div></article>`).join('')||'<p>No bookings.</p>';

  /* ---------- Users ---------- */
  const users=await api('/admin/users');
  const me=getStoredUser();
  const owners=users.filter(u=>u.role==='owner'), regulars=users.filter(u=>u.role==='user'), admins=users.filter(u=>u.role==='admin');
  const userRow=u=>`<p style="padding:10px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(u.name)}</b><br><small>${escapeHtml(u.email)} - ${escapeHtml(u.role)} - Cars: ${u.totalCarsOnRent||0} - Earnings: ${inr(u.ownerEarnings)} - ${escapeHtml(u.carApprovalStatus||'pending')}</small>${u.id!==me.id?`<br><button class="btn btn-outline" style="margin-top:6px;padding:6px 10px" data-del-user="${u.id}" data-del-role="${escapeHtml(u.role)}">Remove ${escapeHtml(u.role)}</button>`:'<br><small>(your account)</small>'}</p>`;
  document.getElementById('adminUsers').innerHTML=
    `<h4>Admins (${admins.length})</h4>`+(admins.map(userRow).join('')||'<p>No admins.</p>')+
    `<h4 style="margin-top:14px">Owners (${owners.length})</h4>`+(owners.map(userRow).join('')||'<p>No owners.</p>')+
    `<h4 style="margin-top:14px">Users (${regulars.length})</h4>`+(regulars.map(userRow).join('')||'<p>No users.</p>');

  /* ---------- Income ---------- */
  try{
    const inc=await api('/admin/income');
    document.getElementById('incomeCards').innerHTML=
      stat('Total revenue',inr(inc.totalRevenue),'Paid rental + ride bookings')+
      stat('Completed revenue',inr(inc.completedRevenue),'Completed paid bookings')+
      stat('Pending revenue',inr(inc.pendingRevenue),'Awaiting payment')+
      stat('Platform share (10%)',inr(inc.commission),'Service share')+
      stat('Owner payout (90%)',inr(inc.ownerPayout),'Paid to owners')+
      stat('Completed bookings',inc.completedBookings,'Finished trips')+
      stat('Pending bookings',inc.pendingBookings,'In progress')+
      stat('Cancelled bookings',inc.cancelledBookings,'Cancelled trips');
    document.getElementById('incomeByVehicle').innerHTML=inc.revenueByVehicle.length?inc.revenueByVehicle.map(v=>`<p style="padding:10px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(v.vehicleName)}</b> (${escapeHtml(v.vehicleType)})<br><small>${escapeHtml(v.ownerName)} - ${v.bookings} booking(s) - Revenue ${inr(v.revenue)} - Owner share ${inr(v.ownerShare)}</small></p>`).join(''):'<p>No paid bookings yet.</p>';
    document.getElementById('incomeByOwner').innerHTML=inc.revenueByOwner.length?inc.revenueByOwner.map(o=>`<p style="padding:10px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(o.ownerName)}</b><br><small>${o.bookings} booking(s) - Revenue ${inr(o.revenue)} - Payout ${inr(o.ownerShare)}</small></p>`).join(''):'<p>No owner revenue yet.</p>';
    document.getElementById('incomeRecent').innerHTML=inc.recent.length?inc.recent.map(t=>`<p style="padding:10px 0;border-bottom:1px solid #e5ebf4;margin:0"><b>${escapeHtml(t.vehicle)}</b><br><small>${escapeHtml(t.renter)} - ${inr(t.amount)} - ${escapeHtml(t.status)} - ${new Date(t.date).toLocaleString('en-IN')}</small></p>`).join(''):'<p>No transactions yet.</p>';
  }catch(e){
    document.getElementById('incomeCards').innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`;
  }

  /* ---------- Reports ---------- */
  document.getElementById('adminReports').innerHTML=
    `<p><b>Users:</b> ${s.users} (owners: ${s.owners})</p>`+
    `<p><b>Vehicles:</b> ${s.vehicles} (pending verification: ${s.pendingVehicleVerification})</p>`+
    `<p><b>Rental bookings:</b> ${s.bookings}</p>`+
    `<p><b>Ride offers:</b> ${s.rides} (seat bookings: ${s.rideBookings})</p>`+
    `<p><b>Total revenue:</b> ${inr(s.totalRevenue)} (platform share ${inr(s.commission)}, owner payout ${inr(s.ownerPayout)})</p>`;

  /* ---------- Admin profile ---------- */
  try{
    const meData=await api('/auth/me');
    document.getElementById('adminProfile').innerHTML=`<p><b>Name:</b> ${escapeHtml(meData.user.name)}</p><p><b>Email:</b> ${escapeHtml(meData.user.email)}</p><p><b>Phone:</b> ${escapeHtml(meData.user.phone||'-')}</p><p><b>Role:</b> admin</p><p><a class="btn btn-outline" href="profile.html">Edit profile</a></p>`;
  }catch{ document.getElementById('adminProfile').innerHTML='<p>Could not load profile.</p>'; }

  /* ---------- Events ---------- */
  const approveVehicle=async id=>{ await api('/admin/vehicles/'+id+'/verify',{method:'PATCH',body:JSON.stringify({verified:true})}); location.reload(); };
  const rejectVehicle=async id=>{ if(!confirm('Reject this vehicle? It will stay pending.'))return; await api('/admin/vehicles/'+id+'/verify',{method:'PATCH',body:JSON.stringify({verified:false})}); location.reload(); };
  document.getElementById('adminVehicles').addEventListener('click',async e=>{
    try{
      const a=e.target.closest('[data-verify]'); if(a){await approveVehicle(a.dataset.verify);return;}
      const r=e.target.closest('[data-reject]'); if(r){await rejectVehicle(r.dataset.reject);return;}
      const d=e.target.closest('[data-del-vehicle]'); if(d){if(!confirm('Remove this vehicle? Past bookings are preserved.'))return; await api('/admin/vehicles/'+d.dataset.delVehicle,{method:'DELETE'}); location.reload();}
    }catch(err){alert(err.message)}
  });
  document.getElementById('adminApprovals').addEventListener('click',async e=>{
    try{
      const a=e.target.closest('[data-verify]'); if(a){await approveVehicle(a.dataset.verify);return;}
      const r=e.target.closest('[data-reject]'); if(r){await rejectVehicle(r.dataset.reject);return;}
    }catch(err){alert(err.message)}
  });
  document.getElementById('adminBookings').addEventListener('click',async e=>{
    const btn=e.target.closest('[data-booking-action]');if(!btn)return;
    if(!confirm(`Set booking to ${btn.dataset.bookingAction}?`))return;
    try{
      await api('/admin/bookings/'+btn.dataset.bookingId+'/status',{method:'PATCH',body:JSON.stringify({status:btn.dataset.bookingAction})});
      location.reload();
    }catch(err){alert(err.message)}
  });
  document.getElementById('adminRides').addEventListener('click',async e=>{
    try{
      const v=e.target.closest('[data-verify-ride]'); if(v){await api('/admin/rides/'+v.dataset.verifyRide+'/verify',{method:'PATCH',body:JSON.stringify({verified:true})}); location.reload();return;}
      const del=e.target.closest('[data-del-ride]'); if(del){if(!confirm('Remove this ride offer and its seat bookings?'))return; await api('/admin/rides/'+del.dataset.delRide,{method:'DELETE'}); location.reload();return;}
      const cancel=e.target.closest('[data-ride-booking-cancel]'); if(cancel){if(!confirm('Cancel this ride booking?'))return; await api('/admin/ride-bookings/'+cancel.dataset.rideBookingCancel+'/status',{method:'PATCH',body:JSON.stringify({status:'cancelled'})}); location.reload();}
    }catch(err){alert(err.message)}
  });
  document.getElementById('adminRideApprovals').addEventListener('click',async e=>{
    try{
      const v=e.target.closest('[data-verify-ride]'); if(v){await api('/admin/rides/'+v.dataset.verifyRide+'/verify',{method:'PATCH',body:JSON.stringify({verified:true})}); location.reload();return;}
      const del=e.target.closest('[data-del-ride]'); if(del){if(!confirm('Remove this ride offer?'))return; await api('/admin/rides/'+del.dataset.delRide,{method:'DELETE'}); location.reload();}
    }catch(err){alert(err.message)}
  });
  document.getElementById('adminUsers').addEventListener('click',async e=>{
    const btn=e.target.closest('[data-del-user]');if(!btn)return;
    if(!confirm(`Remove this ${btn.dataset.delRole} and ALL their vehicles, rides and bookings? This cannot be undone.`))return;
    try{ await api('/admin/users/'+btn.dataset.delUser,{method:'DELETE'}); location.reload(); }
    catch(err){alert(err.message)}
  });
  document.getElementById('addAdminForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const f=e.target, msg=document.getElementById('addAdminMsg');
    try{
      const d=await api('/admin/create-admin',{method:'POST',body:JSON.stringify({name:f.name.value.trim(),email:f.email.value.trim(),phone:f.phone.value.trim(),password:f.password.value,confirmPassword:f.confirmPassword.value})});
      msg.textContent=d.message+' ('+d.user.email+')'; msg.style.display='block'; f.reset();
    }catch(err){ msg.textContent=err.message; msg.style.display='block'; }
  });
 }catch(e){
   const el=document.getElementById('adminStats');
   if(el)el.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`;
 }
});
