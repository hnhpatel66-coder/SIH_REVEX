const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const Booking = require('../models/Booking');
const Agreement = require('../models/Agreement');
const MonthlyBookingCounter = require('../models/MonthlyBookingCounter');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function razorpayRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.razorpay.com',
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.error?.description || `Payment gateway error (${response.statusCode}).`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function reserveMonthlySlot(userId, key) {
  // Keep booking limits compatible with standard database instances.
  // A replica set is NOT required for this counter.
  const updated = await MonthlyBookingCounter.findOneAndUpdate(
    { userId, monthKey: key, count: { $lt: 2 } },
    { $inc: { count: 1 } },
    { new: true }
  );

  if (updated) return updated.count;

  try {
    const [year, month] = key.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 1);

    const existingCount = await Booking.countDocuments({
      userId,
      createdAt: { $gte: monthStart, $lt: monthEnd },
      status: { $in: ['pending', 'payment_pending', 'confirmed', 'completed'] }
    });

    if (existingCount >= 2) {
      throw Object.assign(
        new Error('You can make a maximum of 2 bookings per month.'),
        { code: 'MONTHLY_LIMIT' }
      );
    }

    const created = await MonthlyBookingCounter.create({
      userId,
      monthKey: key,
      count: existingCount + 1
    });

    return created.count;
  } catch (error) {
    // Another request may have created the unique counter between our
    // count and create. Retry the atomic increment in that case.
    if (error?.code === 11000) {
      const retry = await MonthlyBookingCounter.findOneAndUpdate(
        { userId, monthKey: key, count: { $lt: 2 } },
        { $inc: { count: 1 } },
        { new: true }
      );
      if (retry) return retry.count;

      throw Object.assign(
        new Error('You can make a maximum of 2 bookings per month.'),
        { code: 'MONTHLY_LIMIT' }
      );
    }
    throw error;
  }
}

async function releaseMonthlySlot(userId, key) {
  await MonthlyBookingCounter.findOneAndUpdate(
    { userId, monthKey: key, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
}

async function createAgreement(bookingId) {
  const b = await Booking.findById(bookingId).populate('userId','name email phone').populate({
    path:'vehicleId',
    populate:{path:'ownerId',select:'name email phone'}
  });
  if (!b) throw new Error('We could not find that booking. Please try again.');

  const existing = await Agreement.findOne({ bookingId: b._id });
  const vehicle = b.vehicleId;
  const owner = vehicle?.ownerId;

  // Some demo/seed vehicles may not have a valid owner document.
  // Payment/booking must not crash just because agreement owner data is missing.
  if (!vehicle || !b.userId) throw new Error('Booking information is incomplete. Please try again.');

  const agreementId = `AG-${b._id.toString().slice(-8).toUpperCase()}-${Date.now().toString(36).slice(-4).toUpperCase()}`;

  const agreementData = {
    bookingId:b._id,
    agreementId: existing?.agreementId || agreementId,
    renterName:b.userId.name || 'REVEX Renter',
    renterEmail:b.userId.email || '',
    renterPhone:b.userId.phone || '',
    ownerName:owner?.name || 'Vehicle Owner',
    ownerEmail:owner?.email || '',
    ownerPhone:owner?.phone || '',
    vehicleName:vehicle.name || 'REVEX Vehicle',
    vehicleType:vehicle.type || '',
    vehicleLocation:vehicle.location || '',
    vehicleNumberPlate:vehicle.numberPlate || '',
    pickupDate:b.startDate,
    returnDate:b.endDate,
    pickupLocation:vehicle.location || '',
    returnLocation:vehicle.location || '',
    hours:b.hours || 0,
    estimatedKm:b.estimatedKm || 0,
    rentalAmount:b.totalAmount,
    paymentStatus:'PAID',
    acceptedByUser:existing?.acceptedByUser ?? true,
    acceptedAt:existing?.acceptedAt || new Date(),
    acceptedByOwner:existing?.acceptedByOwner || false,
    ownerAcceptedAt:existing?.ownerAcceptedAt,
    termsVersion:'revex-v2'
  };

  if (existing) {
    return Agreement.findOneAndUpdate({bookingId:b._id},agreementData,{new:true,runValidators:true});
  }
  return Agreement.create(agreementData);
}

function escapePdfText(value) {
  return String(value ?? '').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
}

function makeAgreementPdf(a) {
  const dt=v=>{try{return new Date(v).toLocaleString('en-IN')}catch{return String(v||'-')}};
  const lines = [
    'REVEX RENTAL AGREEMENT',
    'Move Smart. Share More.',
    '',
    `Agreement ID: ${a.agreementId}`,
    `Booking ID: ${a.bookingId}`,
    `Booking date: ${dt(a.createdAt||a.acceptedAt)}`,
    '',
    'BOOKING DETAILS',
    `Rental start: ${dt(a.pickupDate)}`,
    `Return: ${dt(a.returnDate)}`,
    `Rental hours: ${a.hours||'-'}`,
    `Pickup location: ${a.pickupLocation||a.vehicleLocation||'-'}`,
    `Return location: ${a.returnLocation||a.vehicleLocation||'-'}`,
    '',
    'RENTER DETAILS',
    `Renter: ${a.renterName}`,
    `Renter contact: ${a.renterEmail}${a.renterPhone?` / ${a.renterPhone}`:''}`,
    '',
    'OWNER DETAILS',
    `Owner: ${a.ownerName}`,
    `Owner contact: ${a.ownerEmail}${a.ownerPhone?` / ${a.ownerPhone}`:''}`,
    '',
    'VEHICLE DETAILS',
    `Vehicle: ${a.vehicleName}${a.vehicleType?` (${a.vehicleType})`:''}`,
    `Registration number: ${a.vehicleNumberPlate || 'As listed'}`,
    `Vehicle location: ${a.vehicleLocation||'-'}`,
    `Permitted kilometres: ${a.estimatedKm||'As shown before confirmation'}`,
    '',
    'PAYMENT DETAILS',
    `Base rental amount: Rs. ${a.rentalAmount}`,
    `Total amount: Rs. ${a.rentalAmount}`,
    `Payment status: ${a.paymentStatus}`,
    '',
    'REVEX RENTER RULES & CONDITIONS',
    '1. Identity Verification: The renter must provide one valid government-issued ID proof',
    'before taking the vehicle. The information provided must be genuine and belong to',
    'the renter.',
    '2. Vehicle Condition & Inspection: Before starting the trip, both the vehicle owner',
    'and renter must record a complete video of the vehicle showing the exterior and',
    'existing damages. A clear odometer photo is the official starting kilometre record.',
    'A final inspection/video and odometer photo may be taken on return. New damage',
    'found after the trip may be the renter responsibility.',
    '3. Fuel Level: The vehicle must be returned with the same fuel level. Recovery',
    'charges apply when it is returned with less fuel.',
    '4. Extra Kilometres: The permitted kilometre limit is specified in the booking.',
    'Start and final odometer readings are compared. Extra kilometres are charged at',
    'the rate shown before confirmation.',
    '5. Responsibility During the Trip: The renter is responsible for tolls, parking',
    'charges, traffic challans/fines, accident-related responsibilities, damage caused',
    'during the rental period and other charges from the renter use or rule violations.',
    '6. Safe & Legal Use: The renter must follow traffic laws. The vehicle must not be',
    'used for illegal activities, racing, reckless driving or unauthorized purposes.',
    'Unauthorized persons must not drive the vehicle.',
    '7. Vehicle Return & Late Return: The vehicle must be returned at the agreed time',
    'and location in the same general condition, except normal wear and tear. Late',
    'return charges apply per the applicable REVEX rate.',
    '8. Agreement: By confirming the booking, the renter confirms they have read,',
    'understood and agreed to these REVEX Renter Rules & Conditions.',
    '',
    `Renter acceptance: ${a.acceptedByUser ? 'YES' : 'PENDING'}`,
    `Owner acceptance: ${a.acceptedByOwner ? 'YES' : 'PENDING'}`,
    '',
    'This document was generated by REVEX from the confirmed booking record.'
  ];

  const wrapped = [];
  for (const line of lines) {
    if (!line) { wrapped.push(''); continue; }
    const text = String(line);
    for (let i=0; i<text.length; i+=88) wrapped.push(text.slice(i,i+88));
  }

  const content = [];
  content.push('BT');
  content.push('/F1 18 Tf');
  content.push('50 760 Td');
  content.push(`(${escapePdfText(wrapped[0] || 'REVEX RENTAL AGREEMENT')}) Tj`);
  content.push('/F1 10 Tf');
  for (const line of wrapped.slice(1)) {
    content.push('0 -22 Td');
    content.push(`(${escapePdfText(line)}) Tj`);
  }
  content.push('ET');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content.join('\n'))} >>\nstream\n${content.join('\n')}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets[i+1] = Buffer.byteLength(pdf);
    pdf += `${i+1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for (let i=1; i<offsets.length; i++) pdf += `${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}

router.post('/', requireAuth, async(req,res)=>{
  const {
    vehicleId,startDate,endDate,estimatedKm=0,
    panNumber='',drivingLicenseNumber=''
  }=req.body;

  if(!mongoose.isValidObjectId(vehicleId)) {
    return res.status(400).json({message:'Valid vehicleId is required.'});
  }

  const pan=String(panNumber).trim().toUpperCase();
  const dl=String(drivingLicenseNumber).trim().toUpperCase();

  // KYC is required before a rental booking can proceed.
  if(!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    return res.status(400).json({message:'Enter a valid PAN number (example: ABCDE1234F).'});
  }
  if(dl.length < 6 || dl.length > 25) {
    return res.status(400).json({message:'Enter a valid driving licence number.'});
  }

  const start=new Date(startDate), end=new Date(endDate);
  if(Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end<=start) {
    return res.status(400).json({message:'Valid start and end dates are required.'});
  }
  if(start <= new Date()) return res.status(400).json({message:'Booking start time must be in the future.'});

  const vehicle=await Vehicle.findById(vehicleId);
  if(!vehicle || vehicle.status!=='available' || !vehicle.verified) {
    return res.status(404).json({message:'Vehicle is not available for booking.'});
  }

  const overlap=await Booking.findOne({
    vehicleId,
    status:{ $in:['pending','payment_pending','confirmed'] },
    startDate:{ $lt:end },
    endDate:{ $gt:start }
  });
  if(overlap) return res.status(409).json({message:'Vehicle is already booked for part of this time.'});

  const hours=Math.max(1,Math.ceil((end-start)/3600000));
  const km=Math.max(0,Number(estimatedKm)||0);
  const extraKm=hours>=24 ? Math.max(0,km-300) : 0;
  const total=hours*vehicle.price + extraKm*10;
  const key=monthKey(new Date());

  let booking;
  try {
    const freshOverlap = await Booking.findOne({
      vehicleId,
      status: { $in: ['pending', 'payment_pending', 'confirmed'] },
      startDate: { $lt: end },
      endDate: { $gt: start }
    });

    if (freshOverlap) {
      return res.status(409).json({
        message: 'Vehicle is already booked for part of this time.'
      });
    }

    const slot = await reserveMonthlySlot(req.user._id, key);

    try {
      booking = await Booking.create({
        userId: req.user._id,
        vehicleId,
        startDate: start,
        endDate: end,
        estimatedKm: km,
        hours,
        totalAmount: total,
        monthKey: key,
        monthlySlot: slot,
        panNumber: pan,
        drivingLicenseNumber: dl,
        paymentMethod: 'demo',
        status: 'payment_pending',
        paymentStatus: 'pending'
      });
    } catch (error) {
      await releaseMonthlySlot(req.user._id, key);
      throw error;
    }
  } catch (e) {
    if (e.code === 'MONTHLY_LIMIT') {
      return res.status(429).json({ message: e.message });
    }
    if (e.code === 11000) {
      return res.status(409).json({
        message: 'A booking is already being created for this account. Please try again.'
      });
    }
    return res.status(400).json({ message: e.message });
  }

  const populated=await Booking.findById(booking._id)
    .populate('vehicleId','name type location price image').lean();

  res.status(201).json({
    ...populated,
    id:booking._id.toString(),
    payment:{
      method:'demo',
      amount:Math.round(total*100),
      currency:'INR',
      displayAmount:total
    }
  });
});

router.post('/:id/payment-demo', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))
    return res.status(400).json({message:'We could not find that booking. Please try again.'});

  const b=await Booking.findOne({
    _id:req.params.id,
    userId:req.user._id,
    status:'payment_pending',
    paymentStatus:'pending'
  });

  if(!b) return res.status(404).json({message:'We could not find that booking. Please try again.'});

  const paymentReference=`REVEX-DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  const updated=await Booking.findOneAndUpdate(
    {_id:b._id,userId:req.user._id,status:'payment_pending',paymentStatus:'pending'},
    {
      paymentStatus:'paid',
      status:'confirmed',
      paymentMethod:'demo',
      paymentReference
    },
    {new:true}
  );

  if(!updated) return res.status(409).json({message:'Booking state changed. Please refresh your bookings.'});

  // Sync denormalized earnings so owner profile / admin analytics stay correct
  try{
    const ownerEarning = Math.round(Number(updated.totalAmount||0) * 0.9);
    const veh = await Vehicle.findByIdAndUpdate(updated.vehicleId, {$inc:{totalEarnings:ownerEarning,totalRentals:1}}, {new:true});
    if(veh){
      const fleetCount = await Vehicle.countDocuments({ownerId:veh.ownerId});
      const approvedCount = await Vehicle.countDocuments({ownerId:veh.ownerId, verified:true});
      const pendingCount = await Vehicle.countDocuments({ownerId:veh.ownerId, verified:false});
      await User.findByIdAndUpdate(veh.ownerId, {
        $inc:{ownerEarnings:ownerEarning},
        $set:{
          totalCarsOnRent:fleetCount,
          carApprovalStatus: approvedCount>0 ? 'approved' : (pendingCount>0 ? 'pending' : 'rejected')
        }
      });
    }
  }catch(syncErr){ console.warn('Earnings sync failed:', syncErr.message); }

  const agreement=await createAgreement(updated._id);

  res.json({
    success:true,
    message:'Payment successful. Booking confirmed.',
    booking:{...updated.toObject(),id:updated._id.toString()},
    agreement,
    paymentReference
  });
});

router.post('/:id/verify-payment', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const existingBooking=await Booking.findOne({_id:req.params.id,userId:req.user._id});
  if(existingBooking?.paymentMethod==='demo') {
    return res.status(400).json({message:'This booking uses the REVEX simple payment flow.'});
  }
  const b=await Booking.findOne({_id:req.params.id,userId:req.user._id});
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  if(b.paymentStatus==='paid') {
    const agreement=await createAgreement(b._id);
    return res.json({success:true,message:'Payment already verified.',booking:{...b.toObject(),id:b._id.toString()},agreement});
  }

  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body;
  if(!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({message:'Payment verification data is incomplete.'});
  }
  if(razorpay_order_id !== b.razorpayOrderId) {
    return res.status(400).json({message:'Payment order does not match this booking.'});
  }

  const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if(razorpay_signature.length !== expected.length || !/^[a-f0-9]+$/i.test(razorpay_signature) ||
     !crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpay_signature))) {
    await Booking.findByIdAndUpdate(b._id,{paymentStatus:'failed',status:'cancelled'});
    await MonthlyBookingCounter.findOneAndUpdate(
      {userId:b.userId,monthKey:b.monthKey,count:{$gt:0}},
      {$inc:{count:-1}}
    );
    return res.status(400).json({message:'Payment verification failed. Booking was not confirmed.'});
  }

  const updated=await Booking.findOneAndUpdate(
    {_id:b._id,userId:req.user._id,status:'payment_pending'},
    {paymentStatus:'paid',status:'confirmed',razorpayPaymentId:razorpay_payment_id,razorpaySignature:razorpay_signature},
    {new:true}
  );
  if(!updated)return res.status(409).json({message:'Booking state changed. Please refresh your bookings.'});

  const agreement=await createAgreement(updated._id);
  res.json({success:true,message:'Payment verified. Booking confirmed.',booking:{...updated.toObject(),id:updated._id.toString()},agreement});
});

router.post('/:id/payment-failed', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const b=await Booking.findOneAndUpdate(
    {_id:req.params.id,userId:req.user._id,status:'payment_pending'},
    {paymentStatus:'failed',status:'cancelled'},
    {new:true}
  );
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  await releaseMonthlySlot(b.userId, b.monthKey);
  res.json({success:true,message:'Payment failed. Your booking has not been confirmed.'});
});


router.post('/:id/cancel', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const b=await Booking.findOne({
    _id:req.params.id,
    userId:req.user._id,
    status:{ $in:['payment_pending','confirmed'] }
  });
  if(!b) return res.status(404).json({message:'This booking cannot be cancelled.'});

  b.status='cancelled';
  // Keep paymentStatus=paid for an audit trail; cancelled bookings are excluded from earnings.
  await b.save();
  if(b.monthKey) await releaseMonthlySlot(b.userId,b.monthKey);

  res.json({
    success:true,
    message:b.paymentStatus==='paid'
      ? 'Booking cancelled. Demo payment is not automatically refunded.'
      : 'Booking cancelled.',
    booking:{...b.toObject(),id:b._id.toString()}
  });
});

/* Feedback/rating for a completed booking. Handles both populated and raw ObjectIds. */
router.post('/:id/feedback', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that booking. Please try again.'});

  const b=await Booking.findById(req.params.id).populate('userId','_id name').populate('vehicleId','_id name ownerId rating');
  if(!b) return res.status(404).json({message:'We could not find that booking. Please try again.'});

  const renterId = b.userId?._id?.toString() || b.userId?.toString();
  const ownerId = b.vehicleId?.ownerId?.toString();
  const isRenter = renterId===req.user._id.toString();
  const isOwner = ownerId===req.user._id.toString();
  if(!isRenter && !isOwner && req.user.role!=='admin') return res.status(403).json({message:'Not allowed.'});

  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim().slice(0,500);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
  }

  b.rating = rating;
  b.comment = comment;
  await b.save();

  // Update vehicle aggregate rating when the renter rates the vehicle
  if (isRenter && b.vehicleId?._id) {
    const vehicle = await Vehicle.findById(b.vehicleId._id);
    if (vehicle) {
      const existing = Number(vehicle.rating) || 5;
      vehicle.rating = Math.round(((existing + rating) / 2) * 10) / 10;
      await vehicle.save();
    }
  }

  res.json({
    success:true,
    message:'Feedback submitted successfully.',
    booking:{...b.toObject(),id:b._id.toString()}
  });
});

router.get('/owner/summary', requireAuth, async(req,res)=>{
  if(!['owner','admin'].includes(req.user.role)) return res.status(403).json({message:'Owner access required.'});

  const vehicleQuery=req.user.role==='admin'?{}:{ownerId:req.user._id};
  const vehicles=await Vehicle.find(vehicleQuery).select('_id ownerId name type location price numberPlate image status verified rating totalEarnings totalRentals').lean();
  const ids=vehicles.map(v=>v._id);
  if(!ids.length) return res.json({
    totalEarnings:0,completedEarnings:0,paidBookings:0,pendingPayments:0,pendingPaymentCount:0,
    activeBookings:0,completedRentals:0,cancelledBookings:0,totalBookings:0,
    totalVehicles:0,approvedVehicles:0,pendingVehicles:0,
    rentedVehicles:0,revenuePerVehicle:[],vehicles:[],recent:[],
    totalCarsOnRent:0,carApprovalStatus:'pending'
  });

  // Counts respect admin scope: admin sees platform totals, owner sees only own fleet
  const countQuery = req.user.role==='admin' ? {} : {ownerId:req.user._id};
  // Rented = vehicles with at least one active (confirmed) booking
  const rentedWithActive = await Booking.distinct('vehicleId',{vehicleId:{$in:ids},status:'confirmed'});
  const approvedVehicles = await Vehicle.countDocuments({ ...countQuery, verified:true });
  const pendingVehicles = await Vehicle.countDocuments({ ...countQuery, verified:false });

  const match={vehicleId:{$in:ids}};
  const [paidAgg,completedAgg,pendingAgg,activeCount,completedCount,cancelledCount,totalCount,paidCount,recent]=await Promise.all([
    Booking.aggregate([{$match:{...match,paymentStatus:'paid',status:{$ne:'cancelled'}}},{$group:{_id:null,total:{$sum:{$multiply:['$totalAmount',0.9]}}}}]),
    Booking.aggregate([{$match:{...match,paymentStatus:'paid',status:'completed'}},{$group:{_id:null,total:{$sum:{$multiply:['$totalAmount',0.9]}}}}]),
    Booking.aggregate([{$match:{...match,paymentStatus:'pending',status:'payment_pending'}},{$group:{_id:null,total:{$sum:'$totalAmount'},count:{$sum:1}}}]),
    Booking.countDocuments({...match,status:'confirmed'}),
    Booking.countDocuments({...match,status:'completed'}),
    Booking.countDocuments({...match,status:'cancelled'}),
    Booking.countDocuments({...match}),
    Booking.countDocuments({...match,paymentStatus:'paid',status:{$ne:'cancelled'}}),
    Booking.find(match).populate('userId','name email').populate('vehicleId','name type').sort({createdAt:-1}).limit(10).lean()
  ]);

  const perVehicle=await Booking.aggregate([
    {$match:{...match}},
    {$group:{_id:'$vehicleId',
      totalBookings:{$sum:1},
      completedRentals:{$sum:{$cond:[{$eq:['$status','completed']},1,0]}},
      cancelledBookings:{$sum:{$cond:[{$eq:['$status','cancelled']},1,0]}},
      earnings:{$sum:{$cond:[{$and:[{$eq:['$paymentStatus','paid']},{$ne:['$status','cancelled']}]},{$multiply:['$totalAmount',0.9]},0]}},
      paidBookings:{$sum:{$cond:[{$and:[{$eq:['$paymentStatus','paid']},{$ne:['$status','cancelled']}]},1,0]}}
    }},
    {$sort:{earnings:-1}}
  ]);
  const pvMap=Object.fromEntries(perVehicle.map(x=>[x._id.toString(),x]));
  const names=Object.fromEntries(vehicles.map(v=>[v._id.toString(),v.name]));
  res.json({
    totalEarnings:Math.round(paidAgg[0]?.total||0),
    completedEarnings:Math.round(completedAgg[0]?.total||0),
    paidBookings:paidCount,
    pendingPayments:Math.round(pendingAgg[0]?.total||0),
    pendingPaymentCount:pendingAgg[0]?.count||0,
    activeBookings:activeCount,
    completedRentals:completedCount,
    cancelledBookings:cancelledCount,
    totalBookings:totalCount,
    totalVehicles:vehicles.length,
    approvedVehicles, pendingVehicles,
    rentedVehicles:rentedWithActive.length,
    totalCarsOnRent:vehicles.length,
    carApprovalStatus: approvedVehicles > 0 ? 'approved' : pendingVehicles > 0 ? 'pending' : 'rejected',
    vehicles:vehicles.map(v=>{
      const st=pvMap[v._id.toString()]||{totalBookings:0,completedRentals:0,cancelledBookings:0,earnings:0,paidBookings:0};
      return {...v,id:v._id.toString(),ownerId:v.ownerId?.toString(),
        approvalLabel: v.verified ? 'Approved' : (v.status==='unavailable' ? 'Rejected' : 'Pending Approval'),
        totalBookings:st.totalBookings,completedRentals:st.completedRentals,cancelledBookings:st.cancelledBookings,
        earnings:Math.round(st.earnings||0),paidBookings:st.paidBookings};
    }),
    revenuePerVehicle:perVehicle.map(x=>({...x,vehicleId:x._id.toString(),vehicleName:names[x._id.toString()]||'Vehicle',earnings:Math.round(x.earnings||0)})),
    recent:recent.map(b=>({...b,id:b._id.toString(),
      userId:b.userId?{name:b.userId.name,email:b.userId.email}:null,
      vehicleId:b.vehicleId?{name:b.vehicleId.name,type:b.vehicleId.type}:null
    }))
  });
});

router.get('/my', requireAuth, async(req,res)=>{
  const docs=await Booking.find({userId:req.user._id})
    .populate('vehicleId','name type location image price numberPlate')
    .sort({createdAt:-1}).lean();

  res.json(docs.map(b=>({
    ...b,id:b._id.toString(),userId:b.userId.toString(),
    vehicleId:b.vehicleId ? {
      id:b.vehicleId._id.toString(),name:b.vehicleId.name,type:b.vehicleId.type,
      location:b.vehicleId.location,image:b.vehicleId.image,price:b.vehicleId.price,
      numberPlate:b.vehicleId.numberPlate||''
    } : null
  })));
});

router.get('/my-agreements', requireAuth, async(req,res)=>{
  const bookings=await Booking.find({userId:req.user._id}).select('_id').lean();
  const ids=bookings.map(b=>b._id);
  const docs=await Agreement.find({bookingId:{$in:ids}}).sort({createdAt:-1}).lean();
  res.json(docs.map(a=>({...a,id:a._id.toString(),bookingId:a.bookingId.toString()})));
});

router.get('/admin/all', requireAuth, async(req,res)=>{
  if(req.user.role!=='admin')return res.status(403).json({message:'Admin access required.'});
  const docs=await Booking.find({}).populate('userId','name email').populate('vehicleId','name type location').sort({createdAt:-1}).lean();
  res.json(docs.map(b=>({...b,id:b._id.toString()})));
});

router.get('/:id/agreement/details', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const b=await Booking.findById(req.params.id)
    .populate('userId','name email phone')
    .populate({path:'vehicleId',select:'name type location price numberPlate ownerId',populate:{path:'ownerId',select:'name email phone'}});

  if(!b) return res.status(404).json({message:'We could not find that booking. Please try again.'});
  const isRenter=b.userId?._id.toString()===req.user._id.toString();
  const isOwner=b.vehicleId?.ownerId?._id?.toString()===req.user._id.toString();
  if(req.user.role!=='admin' && !isRenter && !isOwner) return res.status(403).json({message:'You do not have permission to view this agreement.'});

  const agreement=await Agreement.findOne({bookingId:b._id});
  if(!agreement) return res.status(404).json({message:'The agreement has not been generated yet.'});

  res.json({
    ...agreement.toObject(),
    id:agreement._id.toString(),
    bookingId:b._id.toString(),
    booking:{
      id:b._id.toString(),
      bookingDate:b.createdAt,
      startDate:b.startDate, endDate:b.endDate,
      hours:b.hours||0, estimatedKm:b.estimatedKm||0,
      pickupLocation:b.vehicleId?.location||'',
      returnLocation:b.vehicleId?.location||'',
      totalAmount:b.totalAmount, paymentStatus:b.paymentStatus, status:b.status,
      paymentMethod:b.paymentMethod||'demo'
    },
    renter:{name:b.userId?.name||'',email:b.userId?.email||'',phone:b.userId?.phone||''},
    owner:{name:b.vehicleId?.ownerId?.name||'',email:b.vehicleId?.ownerId?.email||'',phone:b.vehicleId?.ownerId?.phone||''},
    vehicle:{name:b.vehicleId?.name||'',type:b.vehicleId?.type||'',location:b.vehicleId?.location||'',price:b.vehicleId?.price||0,numberPlate:b.vehicleId?.numberPlate||''},
    canOwnerAccept: Boolean((isOwner || req.user.role==='admin') && !agreement.acceptedByOwner),
    canUserSign: Boolean((isRenter || req.user.role==='admin') && !agreement.acceptedByUser),
    fullySigned:Boolean(agreement.acceptedByUser && agreement.acceptedByOwner)
  });
});

router.post('/:id/agreement/owner-accept', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that booking. Please try again.'});

  const b=await Booking.findById(req.params.id).populate({
    path:'vehicleId',
    select:'ownerId',
    populate:{path:'ownerId',select:'name email'}
  });
  if(!b) return res.status(404).json({message:'We could not find that booking. Please try again.'});
  if(req.user.role!=='admin' && b.vehicleId?.ownerId?._id?.toString()!==req.user._id.toString()){
    return res.status(403).json({message:'Only the vehicle owner can accept this agreement.'});
  }

  let agreement=await Agreement.findOne({bookingId:b._id});
  if(!agreement) return res.status(404).json({message:'The agreement has not been generated yet.'});

  agreement.acceptedByOwner=true;
  agreement.ownerAcceptedAt=new Date();
  await agreement.save();

  res.json({
    success:true,
    message:'Owner agreement accepted.',
    agreement:{...agreement.toObject(),id:agreement._id.toString()},
    fullySigned:Boolean(agreement.acceptedByUser && agreement.acceptedByOwner)
  });
});

/* NEW: Allow renter to digitally sign the agreement */
router.post('/:id/agreement/user-sign', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that booking. Please try again.'});

  const b=await Booking.findById(req.params.id);
  if(!b) return res.status(404).json({message:'We could not find that booking. Please try again.'});

  // Check if user is the renter
  const isRenter=b.userId.toString()===req.user._id.toString();
  if(!isRenter && req.user.role!=='admin') return res.status(403).json({message:'Only the renter can sign this agreement.'});

  let agreement=await Agreement.findOne({bookingId:b._id});
  if(!agreement) return res.status(404).json({message:'The agreement has not been generated yet.'});

  agreement.acceptedByUser=true;
  await agreement.save();

  res.json({
    success:true,
    message:'Renter agreement signed.',
    agreement:{...agreement.toObject(),id:agreement._id.toString()},
    fullySigned:Boolean(agreement.acceptedByUser && agreement.acceptedByOwner)
  });
});

router.get('/:id/agreement', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const b=await Booking.findById(req.params.id);
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  const vehicleForAccess=await Vehicle.findById(b.vehicleId).select('ownerId').lean();
  const isRenter=b.userId.toString()===req.user._id.toString();
  const isOwner=vehicleForAccess?.ownerId?.toString()===req.user._id.toString();
  if(req.user.role!=='admin' && !isRenter && !isOwner)return res.status(403).json({message:'Not allowed.'});
  const a=await Agreement.findOne({bookingId:b._id});
  if(!a)return res.status(404).json({message:'The agreement has not been generated yet.'});
  const pdf=makeAgreementPdf(a.toObject());
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition',`attachment; filename="${a.agreementId}.pdf"`);
  res.send(pdf);
});

router.get('/:id', requireAuth, async(req,res)=>{
  if(!mongoose.isValidObjectId(req.params.id))return res.status(400).json({message:'We could not find that booking. Please try again.'});
  const b=await Booking.findById(req.params.id).populate('vehicleId').lean();
  if(!b)return res.status(404).json({message:'We could not find that booking. Please try again.'});
  if(req.user.role!=='admin' && b.userId.toString()!==req.user._id.toString())return res.status(403).json({message:'Not allowed.'});
  res.json({...b,id:b._id.toString()});
});

module.exports=router;
