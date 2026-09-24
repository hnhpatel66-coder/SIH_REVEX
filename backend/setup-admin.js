const path=require('path');
require('dotenv').config({path:path.join(__dirname,'.env')});
require('dotenv').config({path:path.join(__dirname,'..','.env')});
const mongoose=require('mongoose'),bcrypt=require('bcryptjs');
const User=require('./models/User');
(async()=>{
 const uri=process.env.MONGODB_URI||process.env.MONGODB_FALLBACK_URI||'mongodb://127.0.0.1:27017/vroomy';
 try{await mongoose.connect(uri,{serverSelectionTimeoutMS:10000,family:4})}
 catch(e){await mongoose.connect(process.env.MONGODB_FALLBACK_URI||'mongodb://127.0.0.1:27017/vroomy',{serverSelectionTimeoutMS:7000,family:4})}
 const email=(process.env.ADMIN_EMAIL||'admin@vroomy.com').toLowerCase();
 const password=process.env.ADMIN_PASSWORD||'Admin@12345';
 let u=await User.findOne({email});
 if(!u)u=await User.create({name:'REVEX Admin',email,passwordHash:await bcrypt.hash(password,10),role:'admin',isVerified:true});
 else{u.role='admin';u.isVerified=true;u.passwordHash=await bcrypt.hash(password,10);await u.save();}
 console.log('ADMIN VERIFIED');
 console.log('Email:',email);
 console.log('Password:',password);
 console.log('MongoDB:',mongoose.connection.name);
 await mongoose.disconnect();
})().catch(e=>{console.error('Admin setup failed:',e.message);process.exit(1)});
