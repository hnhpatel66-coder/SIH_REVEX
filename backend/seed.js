const path=require('path');
require('dotenv').config({path:path.join(__dirname,'.env')});
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose');
const bcrypt=require('bcryptjs');
const User=require('./models/User');
const Vehicle=require('./models/Vehicle');
const Ride=require('./models/Ride');

const demo=[
  {name:'Honda Activa 6G',category:'Scooter',type:'Scooter',brand:'Honda',model:'Activa 6G',location:'Vesu, Surat',price:80,rating:4.7,currentKm:18000,fuelType:'Petrol',transmission:'Automatic',numberPlate:'GJ05AB1201',image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
  {name:'Yamaha FZ V3',category:'Bike',type:'Bike',brand:'Yamaha',model:'FZ V3',location:'Adajan, Surat',price:100,rating:4.8,currentKm:24000,fuelType:'Petrol',transmission:'Manual',numberPlate:'GJ05AB1202',image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
  {name:'Tata Tiago',category:'Car',type:'Car',brand:'Tata',model:'Tiago',location:'Citylight, Surat',price:240,rating:4.9,currentKm:32000,fuelType:'Petrol',transmission:'Manual',numberPlate:'GJ05AB1203',image:'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'},
  {name:'Ather 450X',category:'Scooter',type:'Scooter',brand:'Ather',model:'450X',location:'Piplod, Surat',price:95,rating:4.6,currentKm:12000,fuelType:'Electric',transmission:'Automatic',numberPlate:'GJ05AB1204',image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
  {name:'TVS Raider',category:'Bike',type:'Bike',brand:'TVS',model:'Raider',location:'Vesu, Surat',price:90,rating:4.5,currentKm:28000,fuelType:'Petrol',transmission:'Manual',numberPlate:'GJ05AB1205',image:'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80'},
  {name:'Hyundai i20',category:'Car',type:'Car',brand:'Hyundai',model:'i20',location:'Athwa, Surat',price:280,rating:4.8,currentKm:41000,fuelType:'Petrol',transmission:'Manual',numberPlate:'GJ05AB1206',image:'https://images.unsplash.com/photo-1549317661-bd32c8ce0db2?auto=format&fit=crop&w=900&q=80'}
];

async function connect(){
  const options={serverSelectionTimeoutMS:10000,family:4};
  try{return await mongoose.connect(process.env.MONGODB_URI,options)}
  catch(error){console.log('Atlas failed, using local fallback.');return mongoose.connect(process.env.MONGODB_FALLBACK_URI||'mongodb://127.0.0.1:27017/vroomy',options)}
}
(async()=>{
  await connect();
  const adminEmail=(process.env.ADMIN_EMAIL||'admin@vroomy.com').toLowerCase();
  let admin=await User.findOne({email:adminEmail});
  const adminPassword=process.env.ADMIN_PASSWORD;
  if(!admin && adminPassword) admin=await User.create({name:process.env.ADMIN_NAME||'REVEX Admin',email:adminEmail,passwordHash:await bcrypt.hash(adminPassword,10),role:'admin',isVerified:true});
<<<<<<< HEAD
  if(admin && admin.role!=='admin'){admin.role='admin';admin.isVerified=true;await admin.save()}
=======
  if(admin){admin.role='admin';admin.isVerified=true;await admin.save()}
>>>>>>> 509eae71e1063d5f8e8f372ee9e73ca177e5dcc1
  let owner=await User.findOne({email:'demo.owner@vroomy.local'});
  const demoPassword=process.env.DEMO_OWNER_PASSWORD;
  if(!owner && demoPassword) owner=await User.create({name:'REVEX Demo Owner',email:'demo.owner@vroomy.local',phone:'9999999999',passwordHash:await bcrypt.hash(demoPassword,10),role:'owner',isVerified:true});
  if(!owner) console.log('Demo owner not created. Set DEMO_OWNER_PASSWORD before seeding.');
  if(owner){
    for(const vehicle of demo){const exists=await Vehicle.findOne({name:vehicle.name,ownerId:owner._id});if(!exists)await Vehicle.create({...vehicle,ownerId:owner._id,priceUnit:'hour',verified:true,status:'approved',availability:'available',numberPlateNormalized:vehicle.numberPlate.replace(/[\s-]/g,'').toUpperCase()});}
  }
  const rideCount=await Ride.countDocuments();
  if(!rideCount && owner) await Ride.insertMany([
    {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Ahmedabad',date:new Date(Date.now()+86400000),time:'08:00',seats:3,price:300,rating:4.8,vehicle:'Hyundai Creta',vehicleType:'Car',fuelType:'Petrol',verified:true,status:'approved'},
    {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Ahmedabad',date:new Date(Date.now()+86400000),time:'09:00',seats:2,price:280,rating:4.7,vehicle:'Maruti Baleno',vehicleType:'Car',fuelType:'Petrol',verified:true,status:'approved'},
    {driverId:owner._id,driver:'REVEX Demo Owner',from:'Surat',to:'Vadodara',date:new Date(Date.now()+172800000),time:'07:30',seats:3,price:190,rating:4.9,vehicle:'Honda City',vehicleType:'Car',fuelType:'Petrol',verified:true,status:'approved'}
  ]);
  console.log('Demo data ready. Existing records were not deleted.');
  console.log('Admin:',adminEmail);
  console.log('Demo owner: demo.owner@vroomy.local (password is taken from DEMO_OWNER_PASSWORD)');
  await mongoose.disconnect();
})().catch(error=>{console.error(error);process.exit(1)});
