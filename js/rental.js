function vehicleCard(v){
 const image=v.image||'';
 return `<article class="vehicle-card"><div class="vehicle-image" style="height:175px;overflow:hidden;background:#eaf1f8">
 <img style="width:100%;height:100%;object-fit:cover;display:block" src="${image}" alt="${v.name}" loading="lazy"
 onerror="this.onerror=null;this.src='data:image/svg+xml;charset=UTF-8,${encodeURIComponent('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"800\" height=\"500\"><rect width=\"100%\" height=\"100%\" fill=\"#eaf1f8\"/><text x=\"50%\" y=\"50%\" text-anchor=\"middle\" dominant-baseline=\"middle\" font-family=\"Arial\" font-size=\"28\" fill=\"#64748b\">REVEX Vehicle</text></svg>')}';">
 </div><div class="card-body"><div class="card-top"><div><h3 class="card-title">${v.name}</h3><div class="card-meta">${v.type} · 📍 ${v.location}</div></div><span class="rating">★ ${v.rating||5}</span></div><span class="pill">● Available</span><p class="card-price">₹${v.price} <small>/ hour</small></p><div class="card-actions"><a class="btn btn-outline" href="vehicle-details.html?id=${v.id}">Details</a><a class="btn btn-primary" href="vehicle-details.html?id=${v.id}">Book now</a></div></div></article>`;
}
async function renderVehicles(filters={}){
 const box=document.getElementById('vehicleResults'); if(!box)return;
 box.innerHTML='<div class="empty">Loading vehicles...</div>';
 try{
  const p=new URLSearchParams();
  if(filters.location)p.set('location',filters.location);
  if(filters.type)p.set('type',filters.type);
  if(filters.maxPrice)p.set('maxPrice',filters.maxPrice);
  const list=await api('/vehicles?'+p.toString());
  box.innerHTML=list.length?list.map(vehicleCard).join(''):'<div class="empty">No vehicles match those filters.</div>';
 }catch(e){box.innerHTML=`<div class="empty">${e.message}</div>`}
}
function calculateRental(){
 const f=document.getElementById('rentalBooking'); if(!f)return;
 const start=new Date(f.startDate.value+'T'+f.startTime.value);
 const end=new Date(f.endDate.value+'T'+f.endTime.value);
 const price=+document.getElementById('hourlyPrice').value;
 const km=parseInt(f.estimatedKm?.value||'0',10);
 if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start){
   document.getElementById('rentalTotal').innerHTML='<span>Choose valid future times to see total</span>';
   delete document.getElementById('rentalTotal').dataset.total;
   return;
 }
 const hours=Math.max(1,Math.ceil((end-start)/36e5));
 const extraKm=hours>=24?Math.max(0,km-300):0;
 const total=hours*price+extraKm*10;
 document.getElementById('rentalTotal').innerHTML='<span>'+hours+' hour'+(hours>1?'s':'')+' × ₹'+price+(extraKm?' + extra km ₹'+(extraKm*10):'')+'</span><strong>₹'+total+'</strong>';
 document.getElementById('rentalTotal').dataset.total=total;
}
async function confirmRental(e){
 e.preventDefault();
 if(!requireLogin())return;
 calculateRental();

 const f=e.target;
 const total=+document.getElementById('rentalTotal').dataset.total;
 const vehicleId=f.dataset.vehicleId;

 if(!vehicleId){
   alert('Vehicle information is missing. Please reopen the vehicle from Rent a Vehicle.');
   return;
 }
 if(!total){
   alert('Please select a valid future start and end time.');
   return;
 }

 const button=f.querySelector('button[type="submit"]');
 if(button){button.disabled=true;button.textContent='Preparing payment...';}

 try{
   const b=await api('/bookings',{
     method:'POST',
     body:JSON.stringify({
       vehicleId,
       startDate:f.startDate.value+'T'+f.startTime.value,
       endDate:f.endDate.value+'T'+f.endTime.value,
       estimatedKm:Number(f.estimatedKm.value)||0,
       panNumber:f.panNumber.value.trim(),
       drivingLicenseNumber:f.drivingLicenseNumber.value.trim()
     })
   });

   const payment=document.getElementById('simplePaymentModal');
   const amount=document.getElementById('simplePaymentAmount');
   if(amount) amount.textContent='₹'+Number(b.totalAmount||total).toLocaleString('en-IN');
   payment?.classList.add('show');

   const pay=document.getElementById('simplePayNow');
   const cancel=document.getElementById('simplePayCancel');

   if(pay){
     pay.onclick=async()=>{
       pay.disabled=true;
       pay.textContent='Processing...';
       try{
         const result=await api('/bookings/'+b.id+'/payment-demo',{method:'POST'});
         payment?.classList.remove('show');

         const modal=document.getElementById('successModal');
         modal?.querySelector('h2')?.replaceChildren(document.createTextNode('Booking Successful!'));
         modal?.querySelector('p')?.replaceChildren(
           document.createTextNode(`Payment successful. Agreement ID: ${result.agreement?.agreementId||'generated'}`)
         );

         const dl=document.getElementById('downloadAgreementBtn');
         if(dl){
           dl.style.display='inline-flex';
           dl.onclick=()=>downloadAgreement(b.id);
         }
         modal?.classList.add('show');
       }catch(err){
         alert(err.message);
       }finally{
         pay.disabled=false;
         pay.textContent='Pay Now';
         if(button){button.disabled=false;button.textContent='Proceed to payment';}
       }
     };
   }

   if(cancel){
     cancel.onclick=async()=>{
       payment?.classList.remove('show');
       try{await api('/bookings/'+b.id+'/payment-failed',{method:'POST'})}catch{}
       if(button){button.disabled=false;button.textContent='Proceed to payment';}
     };
   }
 }catch(err){
   alert(err.message);
   if(button){button.disabled=false;button.textContent='Proceed to payment';}
 }
}

function setSafeBookingDefaults(){
 const f=document.getElementById('rentalBooking'); if(!f)return;
 const now=new Date();
 now.setMinutes(Math.ceil((now.getMinutes()+1)/15)*15,0,0);
 if(now<=new Date()) now.setHours(now.getHours()+1);
 const end=new Date(now.getTime()+2*60*60*1000);
 const fmtDate=d=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${day}`};
 const fmtTime=d=>`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
 if(f.startDate){f.startDate.value=fmtDate(now);f.startDate.min=fmtDate(now);f.startTime.value=fmtTime(now);}
 if(f.endDate){f.endDate.value=fmtDate(end);f.endTime.value=fmtTime(end);}
 calculateRental();
}
document.addEventListener('DOMContentLoaded',async()=>{
 const form=document.getElementById('rentalSearch');
 if(form){await renderVehicles();form.addEventListener('submit',e=>{e.preventDefault();renderVehicles({location:form.location.value.trim(),type:form.type.value,maxPrice:form.maxPrice.value})});}
 const detail=document.getElementById('vehicleDetail');
 if(detail){
  const id=new URLSearchParams(location.search).get('id');
  if(!id){detail.innerHTML='<div class="empty">Vehicle ID is missing.</div>';return}
  try{
   const v=await api('/vehicles/'+encodeURIComponent(id));
   detail.dataset.vehicleId=v.id;
   const image=v.image||'';
   detail.innerHTML=`<div class="detail-vehicle"><img style="width:100%;height:100%;object-fit:cover" src="${image}" alt="${v.name}" onerror="this.style.objectFit='contain'"></div><span class="pill">● ${v.verified?'Verified':'Pending verification'}</span><h1 class="section-title">${v.name}</h1><p>${v.type} · ${v.location} · Owner rating <span class="rating">★ ${v.rating||5}</span></p><hr><h3>Ready for your city journey</h3><p>Well maintained, verified and insured for a smooth ride. Pick up from the listed location and travel on your schedule.</p><div class="ride-details"><div><b>Price</b>₹${v.price}/hour</div><div><b>Fuel</b>Included</div><div><b>Minimum booking</b>1 hour</div><div><b>Cancellation</b>Free before payment</div></div>`;
   document.getElementById('hourlyPrice').value=v.price;
   document.getElementById('rentalBooking').dataset.vehicleId=v.id;
   setSafeBookingDefaults();
  }catch(e){detail.innerHTML=`<div class="empty">${e.message}</div>`}
 }
});
