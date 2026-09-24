const path=require('path');
require('dotenv').config({path:path.join(__dirname,'.env')});
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const bcrypt=require('bcryptjs');
const User=require('./models/User');
const Vehicle=require('./models/Vehicle');
const Ride=require('./models/Ride');

const demo=[
 {name:'Honda Activa 6G',type:'Scooter',location:'Vesu, Surat',price:80,rating:4.7,image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
 {name:'Yamaha FZ V3',type:'Bike',location:'Adajan, Surat',price:100,rating:4.8,image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
 {name:'Tata Tiago',type:'Car',location:'Citylight, Surat',price:240,rating:4.9,image:'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'},
 {name:'Ather 450X',type:'Scooter',location:'Piplod, Surat',price:95,rating:4.6,image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
 {name:'TVS Raider',type:'Bike',location:'Vesu, Surat',price:90,rating:4.5,image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
 {name:'Hyundai i20',type:'Car',location:'Athwa, Surat',price:280,rating:4.8,image:'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'}
];

async function connect(){
 try{return await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:10000,family:4})}
 catch(e){
  console.log('Atlas failed, using local fallback.');
  return mongoose.connect(process.env.MONGODB_FALLBACK_URI||'mongodb://127.0.0.1:27017/vroomy',{serverSelectionTimeoutMS:7000,family:4});
 }
}
(async()=>{
 await connect();
 const adminEmail=(process.env.ADMIN_EMAIL||'admin@vroomy.com').toLowerCase();
 let admin=await User.findOne({email:adminEmail});
 const adminPassword=process.env.ADMIN_PASSWORD||'Admin@12345';
 if(!admin) admin=await User.create({name:'REVEX Admin',email:adminEmail,passwordHash:await bcrypt.hash(adminPassword,10),role:'admin',isVerified:true});
 else {admin.role='admin';admin.isVerified=true;admin.passwordHash=await bcrypt.hash(adminPassword,10);await admin.save();}

 let owner=await User.findOne({email:'demo.owner@vroomy.local'});
 if(!owner) owner=await User.create({name:'REVEX Demo Owner',email:'demo.owner@vroomy.local',phone:'9999999999',passwordHash:await bcrypt.hash('Demo@12345',10),role:'owner',isVerified:true});

 for(const v of demo){
  const exists=await Vehicle.findOne({name:v.name,ownerId:owner._id});
  if(!exists) await Vehicle.create({...v,ownerId:owner._id,verified:true,status:'available'});
 }

 const rideCount=await Ride.countDocuments();
 if(!rideCount) await Ride.insertMany([
  {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Ahmedabad',date:new Date('2026-09-20'),time:'08:00',seats:3,price:300,rating:4.8,vehicle:'Hyundai Creta'},
  {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Ahmedabad',date:new Date('2026-09-20'),time:'09:00',seats:2,price:280,rating:4.7,vehicle:'Maruti Baleno'},
  {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Vadodara',date:new Date('2026-09-21'),time:'07:30',seats:3,price:190,rating:4.9,vehicle:'Honda City'}
 ]);
 console.log('Demo data ready.');
 console.log('Admin:',adminEmail);
 console.log('Demo owner: demo.owner@vroomy.local / Demo@12345');
 await mongoose.disconnect();
})().catch(e=>{console.error(e);process.exit(1)});
