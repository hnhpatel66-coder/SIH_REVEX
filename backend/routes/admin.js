const express=require('express');
const mongoose=require('mongoose');
const bcrypt=require('bcryptjs');
const Vehicle=require('../models/Vehicle');
const Booking=require('../models/Booking');
const User=require('../models/User');
const Ride=require('../models/Ride');
const RideBooking=require('../models/RideBooking');
const Agreement=require('../models/Agreement');
const {requireAuth,requireRole}=require('../middleware/auth');
const router=express.Router();

router.get('/summary',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    const [users,owners,vehicles,bookings,rides,pending,paidAgg,ridePaidAgg]=await Promise.all([
      User.countDocuments(),
      User.countDocuments({role:'owner'}),
      Vehicle.countDocuments(),
      Booking.countDocuments(),
      Ride.countDocuments(),
      Vehicle.countDocuments({verified:false}),
      Booking.aggregate([{$match:{paymentStatus:'paid',status:{$ne:'cancelled'}}},{$group:{_id:null,gross:{$sum:'$totalAmount'},commission:{$sum:{$multiply:['$totalAmount',0.10]}}}}]),
      RideBooking.aggregate([{$match:{paymentStatus:'paid',status:{$ne:'cancelled'}}},{$group:{_id:null,gross:{$sum:'$totalAmount'},commission:{$sum:{$multiply:['$totalAmount',0.10]}}}}])
    ]);
    const gross=(paidAgg[0]?.gross||0)+(ridePaidAgg[0]?.gross||0);
    const commission=(paidAgg[0]?.commission||0)+(ridePaidAgg[0]?.commission||0);
    res.json({
      users,owners,vehicles,bookings,rides,
      pendingVehicleVerification:pending,
      totalRevenue:gross,
      grossRevenue:gross,
      commission,
      ownerPayout:gross-commission,
      rideBookings:await RideBooking.countDocuments()
    });
  }catch(e){res.status(500).json({message:'Could not load admin summary: '+e.message});}
});

router.get('/users',requireAuth,requireRole('admin'),async(req,res)=>{
  const users=await User.find({}).select('-passwordHash -resetPasswordToken -resetPasswordExpires').sort({createdAt:-1}).lean();
  res.json(users.map(u=>({...u,id:u._id.toString()})));
});

/* Admin creates a new admin. Validation + duplicate prevention, password never returned. */
router.post('/create-admin',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    const {name,email,password,confirmPassword,phone}=req.body||{};
    if(!name||!String(name).trim())return res.status(400).json({message:'Full name is required.'});
    if(!email||!String(email).trim())return res.status(400).json({message:'Email is required.'});
    const normalizedEmail=String(email).toLowerCase().trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))return res.status(400).json({message:'Enter a valid email address.'});
    if(!password||String(password).length<8)return res.status(400).json({message:'Password must be at least 8 characters.'});
    if(confirmPassword!==undefined&&password!==confirmPassword)return res.status(400).json({message:'Passwords do not match.'});
    if(await User.exists({email:normalizedEmail}))return res.status(409).json({message:'An account with this email already exists.'});
    const passwordHash=await bcrypt.hash(String(password),10);
    const admin=await User.create({name:String(name).trim(),email:normalizedEmail,phone:phone?String(phone).trim():'',passwordHash,role:'admin',isVerified:true});
    res.status(201).json({message:'Admin account created successfully.',user:{id:admin._id.toString(),name:admin.name,email:admin.email,phone:admin.phone||'',role:admin.role}});
  }catch(e){res.status(500).json({message:'Could not create admin. Please try again.'});}
});

/* Platform income computed from real booking data. No invented values. */
router.get('/income',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    const paidMatch={paymentStatus:'paid',status:{$ne:'cancelled'}};
    const [rentalPaid,rentalPending,ridePaid,completedCount,pendingCount,cancelledCount]=await Promise.all([
      Booking.aggregate([{$match:paidMatch},{$group:{_id:null,gross:{$sum:'$totalAmount'},count:{$sum:1}}}]),
      Booking.aggregate([{$match:{paymentStatus:'pending',status:'payment_pending'}},{$group:{_id:null,gross:{$sum:'$totalAmount'},count:{$sum:1}}}]),
      RideBooking.aggregate([{$match:paidMatch},{$group:{_id:null,gross:{$sum:'$totalAmount'},count:{$sum:1}}}]),
      Booking.countDocuments({paymentStatus:'paid',status:'completed'}),
      Booking.countDocuments({status:'payment_pending'}),
      Booking.countDocuments({status:'cancelled'})
    ]);
    const rentalGross=rentalPaid[0]?.gross||0, rideGross=ridePaid[0]?.gross||0;
    const gross=rentalGross+rideGross, commission=Math.round(gross*0.10), ownerPayout=gross-commission;
    const byVehicle=await Booking.aggregate([
      {$match:paidMatch},
      {$group:{_id:'$vehicleId',bookings:{$sum:1},revenue:{$sum:'$totalAmount'}}},
      {$sort:{revenue:-1}},{$limit:20}
    ]);
    const vIds=byVehicle.map(x=>x._id);
    const vDocs=await Vehicle.find({_id:{$in:vIds}}).select('name type ownerId').lean();
    const vMap=Object.fromEntries(vDocs.map(v=>[v._id.toString(),v]));
    const ownerIds=[...new Set(vDocs.map(v=>String(v.ownerId)))].filter(id=>mongoose.isValidObjectId(id));
    const oDocs=await User.find({_id:{$in:ownerIds}}).select('name email').lean();
    const oMap=Object.fromEntries(oDocs.map(o=>[o._id.toString(),o]));
    const byOwnerMap={};
    for(const row of byVehicle){
      const v=vMap[String(row._id)];
      const key=v?String(v.ownerId):'unknown';
      byOwnerMap[key]=byOwnerMap[key]||{ownerId:key,ownerName:(oMap[key]?.name||'Owner'),bookings:0,revenue:0};
      byOwnerMap[key].bookings+=row.bookings; byOwnerMap[key].revenue+=row.revenue;
    }
    const recent=await Booking.find({paymentStatus:'paid',status:{$ne:'cancelled'}}).populate('userId','name').populate('vehicleId','name').sort({createdAt:-1}).limit(10).lean();
    res.json({
      totalRevenue:gross, completedRevenue:gross,
      pendingRevenue:rentalPending[0]?.gross||0,
      commission, ownerPayout,
      completedBookings:completedCount,
      pendingBookings:pendingCount, cancelledBookings:cancelledCount,
      rentalBookings:rentalPaid[0]?.count||0, rideBookings:ridePaid[0]?.count||0,
      revenueByVehicle:byVehicle.map(x=>{
        const v=vMap[String(x._id)];
        return {vehicleId:String(x._id),vehicleName:v?.name||'Vehicle',vehicleType:v?.type||'',ownerName:oMap[v?String(v.ownerId):'']?.name||'',bookings:x.bookings,revenue:x.revenue,ownerShare:Math.round(x.revenue*0.9)};
      }),
      revenueByOwner:Object.values(byOwnerMap).map(o=>({...o,ownerShare:Math.round(o.revenue*0.9)})).sort((a,b)=>b.revenue-a.revenue),
      recent:recent.map(b=>({id:b._id.toString(),vehicle:b.vehicleId?.name||'Vehicle',renter:b.userId?.name||'Renter',amount:b.totalAmount,status:b.status,date:b.createdAt}))
    });
  }catch(e){res.status(500).json({message:'Could not load income data. Please try again.'});}
});

router.patch('/vehicles/:id/verify',requireAuth,requireRole('admin'),async(req,res)=>{
  if(req.body.verified===undefined)return res.status(400).json({message:'verified must be true or false.'});
  const verified=req.body.verified===true || req.body.verified==='true';
  const v=await Vehicle.findByIdAndUpdate(
    req.params.id,
    {verified,status:verified?'available':'pending'},
    {new:true,runValidators:true}
  );
  if(!v)return res.status(404).json({message:'We could not find that vehicle. Please try again.'});
  try{
    const approvedCount = await Vehicle.countDocuments({ownerId:v.ownerId, verified:true});
    const pendingCount = await Vehicle.countDocuments({ownerId:v.ownerId, verified:false});
    await User.findByIdAndUpdate(v.ownerId, {$set:{
      carApprovalStatus: approvedCount>0 ? 'approved' : (pendingCount>0 ? 'pending' : 'rejected')
    }});
  }catch(e){ console.warn('Approval sync failed:', e.message); }
  res.json(v);
});

/* Admin removes a listed vehicle. Vehicles with booking history are deactivated
   (status unavailable) instead of destroyed so past bookings stay intact. */
router.delete('/vehicles/:id',requireAuth,requireRole('admin'),async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that vehicle. Please try again.'});
  const v=await Vehicle.findById(req.params.id);
  if(!v)return res.status(404).json({message:'We could not find that vehicle. Please try again.'});
  try{
    const historyCount=await Booking.countDocuments({vehicleId:v._id});
    if(historyCount>0){
      v.status='unavailable'; v.verified=false;
      await v.save();
    }else{
      await Vehicle.findByIdAndDelete(v._id);
    }
    const fleetCount = await Vehicle.countDocuments({ownerId:v.ownerId});
    const approvedCount = await Vehicle.countDocuments({ownerId:v.ownerId, verified:true});
    const pendingCount = await Vehicle.countDocuments({ownerId:v.ownerId, verified:false});
    await User.findByIdAndUpdate(v.ownerId, {$set:{
      totalCarsOnRent:fleetCount,
      carApprovalStatus: fleetCount===0 ? 'pending' : (approvedCount>0 ? 'approved' : (pendingCount>0 ? 'pending' : 'rejected'))
    }});
    res.json({message: historyCount>0 ? 'Vehicle deactivated. Past bookings were preserved.' : 'Vehicle removed.'});
  }catch(e){ res.status(500).json({message:'Something went wrong. Please try again later.'}); }
});

router.get('/bookings',requireAuth,requireRole('admin'),async(req,res)=>{
  const docs=await Booking.find({}).populate('userId','name email').populate('vehicleId','name type location').sort({createdAt:-1}).lean();
  res.json(docs.map(b=>({...b,id:b._id.toString()})));
});

router.patch('/bookings/:id/status',requireAuth,requireRole('admin'),async(req,res)=>{
  const allowed=['cancelled','completed'];
  if(!allowed.includes(req.body.status)){
    return res.status(400).json({message:'Admin can set booking status to cancelled or completed.'});
  }
  const b=await Booking.findById(req.params.id);
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  if(req.body.status==='completed' && b.paymentStatus!=='paid'){
    return res.status(400).json({message:'Only a paid booking can be marked completed.'});
  }
  if(req.body.status==='cancelled' && b.paymentStatus==='paid'){
    return res.status(400).json({message:'A paid booking cannot be cancelled without a refund process.'});
  }
  b.status=req.body.status;
  await b.save();
  res.json({...b.toObject(),id:b._id.toString()});
});

/* NEW: Admin can cancel any ride/booking */
router.post('/bookings/cancel',requireAuth,requireRole('admin'),async(req,res)=>{
  const {id}=req.body;
  if(!id)return res.status(400).json({message:'Booking ID is required.'});
  const b=await Booking.findById(id);
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  b.status='cancelled';
  await b.save();
  res.json({success:true,message:'Booking cancelled by admin.',booking:{...b.toObject(),id:b._id.toString()}});
});

router.get('/ride-bookings',requireAuth,requireRole('admin'),async(req,res)=>{
  const docs=await RideBooking.find({}).populate('userId','name email').populate('rideId').sort({createdAt:-1}).lean();
  res.json(docs.map(b=>({...b,id:b._id.toString()})));
});

/* Admin can remove any user or owner. Cascades to their vehicles, rides and bookings. */
router.delete('/users/:id',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that account. Please try again.'});
    if(req.params.id===req.user._id.toString())return res.status(400).json({message:'You cannot delete your own admin account.'});
    const target=await User.findById(req.params.id);
    if(!target)return res.status(404).json({message:'We could not find that account. Please try again.'});
    if(target.role==='admin'){
      const adminCount=await User.countDocuments({role:'admin'});
      if(adminCount<=1)return res.status(400).json({message:'Cannot delete the last admin account.'});
    }
    const targetId=target._id;
    const vehicles=await Vehicle.find({ownerId:targetId}).select('_id').lean();
    const vehicleIds=vehicles.map(v=>v._id);
    if(vehicleIds.length){
      await Booking.deleteMany({vehicleId:{$in:vehicleIds}});
      await Vehicle.deleteMany({_id:{$in:vehicleIds}});
    }
    await Booking.deleteMany({userId:targetId});
    await RideBooking.deleteMany({userId:targetId});
    const rides=await Ride.find({driverId:targetId}).select('_id').lean();
    const rideIds=rides.map(r=>r._id);
    if(rideIds.length){
      await RideBooking.deleteMany({rideId:{$in:rideIds}});
      await Ride.deleteMany({_id:{$in:rideIds}});
    }
    await Agreement.deleteMany({$or:[{renterEmail:target.email},{ownerEmail:target.email}]});
    await User.findByIdAndDelete(targetId);
    res.json({success:true,message:`${target.role} account and all related vehicles, rides and bookings removed.`});
  }catch(e){res.status(500).json({message:'Could not delete user: '+e.message});}
});

/* Admin can remove any ride offer and its seat bookings. */
router.delete('/rides/:id',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that ride. Please try again.'});
    const r=await Ride.findById(req.params.id);
    if(!r)return res.status(404).json({message:'We could not find that ride. Please try again.'});
    await RideBooking.deleteMany({rideId:r._id});
    await Ride.findByIdAndDelete(r._id);
    res.json({success:true,message:'Ride offer and its seat bookings removed.'});
  }catch(e){res.status(500).json({message:'Could not delete ride: '+e.message});}
});

/* Admin can cancel any ride seat booking. */
router.patch('/ride-bookings/:id/status',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    const allowed=['cancelled','completed','confirmed'];
    if(!allowed.includes(req.body.status))return res.status(400).json({message:'Admin can set ride booking status to cancelled, confirmed or completed.'});
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that ride booking. Please try again.'});
    const b=await RideBooking.findById(req.params.id);
    if(!b)return res.status(404).json({message:'Ride booking not found.'});
    b.status=req.body.status;
    await b.save();
    res.json({...b.toObject(),id:b._id.toString()});
  }catch(e){res.status(500).json({message:'Could not update ride booking: '+e.message});}
});

/* Admin approves or rejects a ride offer (vehicle image + details verification). */
router.patch('/rides/:id/verify',requireAuth,requireRole('admin'),async(req,res)=>{
  try{
    if(req.body.verified===undefined)return res.status(400).json({message:'verified must be true or false.'});
    if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that ride. Please try again.'});
    const verified=req.body.verified===true||req.body.verified==='true';
    const r=await Ride.findByIdAndUpdate(req.params.id,{verified,status:verified?'available':'pending'},{new:true});
    if(!r)return res.status(404).json({message:'We could not find that ride. Please try again.'});
    res.json({...r.toObject(),id:r._id.toString()});
  }catch(e){res.status(500).json({message:'Could not verify ride: '+e.message});}
});

module.exports=router;
