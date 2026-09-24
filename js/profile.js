document.addEventListener('DOMContentLoaded',()=>{
 const form=document.getElementById('loginForm'); if(!form)return;
 form.addEventListener('submit',async e=>{
  e.preventDefault();
  try{
   const userId=document.getElementById('userId')?.value.trim(),password=document.getElementById('password')?.value;
   const data=await api('/auth/login',{method:'POST',body:JSON.stringify({userId,password})});
   setSession(data);
   if(data.user.role==='admin') location.href='admin.html'; else if(data.user.role==='owner') location.href='list-vehicle.html'; else location.href='index.html';
  }catch(err){alert(err.message)}
 });
});
