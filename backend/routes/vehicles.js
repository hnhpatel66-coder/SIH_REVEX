const express = require('express');
const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const demoImages = [
  'https://dukaan.b-cdn.net/700x700/webp/media/257922e3-935a-42b9-8074-dc86daac2d84.jpeg',
  'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80',
  'https://images10.gaadi.com/usedcar_image/BP2A.250605.031.A3/original/37e4c941-b5e9-4d07-bc3d-04100fbc6546.jpg'
];

function serialize(v) {
  return { ...v, id: v._id.toString(), ownerId: v.ownerId?.toString() };
}

router.get('/', async (req,res) => {
  try {
    const q = {};
    if (req.query.location) q.location = { $regex: req.query.location, $options: 'i' };
    if (req.query.type) q.type = req.query.type;
    if (req.query.maxPrice) q.price = { $lte: Number(req.query.maxPrice) };
    if (req.query.status !== 'all') q.status = 'available';

    const docs = await Vehicle.find(q).sort({ createdAt: -1 }).lean();
    res.json(docs.map(serialize));
  } catch(e) {
    res.status(500).json({message:e.message});
  }
});

router.get('/mine', requireAuth, requireRole('owner','admin'), async (req,res) => {
  const q = req.user.role === 'admin' ? {} : { ownerId: req.user._id };
  const docs = await Vehicle.find(q).sort({createdAt:-1}).lean();
  res.json(docs.map(serialize));
});

router.get('/:id', async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that vehicle. Please try again.'});
  const v = await Vehicle.findById(req.params.id).lean();
  if (!v) return res.status(404).json({message:'We could not find that vehicle. Please try again.'});
  res.json(serialize(v));
});

router.post('/', requireAuth, requireRole('owner','admin'), async (req,res) => {
  try {
    const b=req.body;
    if (!b.name || !b.type || !b.location || !Number(b.price)) {
      return res.status(400).json({message:'Vehicle name, type, location and price are required.'});
    }

    const image = typeof b.vehiclePicture === 'string' && b.vehiclePicture.startsWith('data:image/')
      ? b.vehiclePicture
      : (typeof b.image === 'string' && b.image ? b.image : demoImages[0]);

    const v=await Vehicle.create({
      ownerId:req.user._id,
      name:b.name.trim(),
      type:b.type,
      location:b.location.trim(),
      price:Number(b.price),
      availableFrom:b.available || undefined,
      numberPlate:b.numberPlate || '',
      ownershipPaper:b.ownershipPaper || '',
      insurance:b.insurance || '',
      puc:b.puc || '',
      vehiclePicture:b.vehiclePicture || '',
      image,
      verified:false,
      status:'pending'
    });
    // Keep owner fleet counters correct
    try{
      const fleetCount = await Vehicle.countDocuments({ownerId:req.user._id});
      await User.findByIdAndUpdate(req.user._id, {$set:{totalCarsOnRent:fleetCount, carApprovalStatus:'pending'}});
    }catch(e){ console.warn('Owner counter sync failed:', e.message); }
    res.status(201).json({...v.toObject(),id:v._id.toString(),ownerId:v.ownerId.toString()});
  } catch(e) {
    res.status(400).json({message:e.message});
  }
});

router.put('/:id', requireAuth, requireRole('owner','admin'), async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that vehicle. Please try again.'});

  const allowed = ['name','type','location','price','availableFrom','numberPlate','ownershipPaper','insurance','puc','vehiclePicture','image'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) updates[key] = req.body[key];
  }
  if (typeof updates.vehiclePicture === 'string' && updates.vehiclePicture.startsWith('data:image/')) {
    updates.image = updates.vehiclePicture;
  }

  if (req.user.role === 'admin') {
    if (Object.prototype.hasOwnProperty.call(req.body, 'verified')) {
      updates.verified = req.body.verified === true || req.body.verified === 'true';
      updates.status = updates.verified ? 'available' : 'pending';
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) updates.status = req.body.status;
  }

  const q = req.user.role === 'admin' ? {_id:req.params.id} : {_id:req.params.id, ownerId:req.user._id};
  const v=await Vehicle.findOneAndUpdate(q,updates,{new:true,runValidators:true}).lean();
  if(!v)return res.status(404).json({message:'We could not find that vehicle. Please try again.'});
  res.json(serialize(v));
});

router.delete('/:id', requireAuth, requireRole('owner','admin'), async (req,res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({message:'We could not find that vehicle. Please try again.'});
  const q = req.user.role === 'admin' ? {_id:req.params.id} : {_id:req.params.id, ownerId:req.user._id};
  const v=await Vehicle.findOne(q);
  if(!v)return res.status(404).json({message:'We could not find that vehicle. Please try again.'});
  try{
    const Booking = require('../models/Booking');
    const historyCount = await Booking.countDocuments({vehicleId:v._id});
    if(historyCount>0){
      // Preserve booking history: deactivate instead of destroying the record.
      v.status='unavailable'; v.verified=false;
      await v.save();
    }else{
      await Vehicle.findByIdAndDelete(v._id);
    }
    const fleetCount = await Vehicle.countDocuments({ownerId:v.ownerId});
    await User.findByIdAndUpdate(v.ownerId, {$set:{totalCarsOnRent:fleetCount}});
    res.json({message: historyCount>0 ? 'Vehicle deactivated. Past bookings were preserved.' : 'Vehicle deleted.'});
  }catch(e){ res.status(500).json({message:'Something went wrong. Please try again later.'}); }
});

module.exports=router;
