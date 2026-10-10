import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGO_URI);
const u = mongoose.connection.collection('users');
const rows = await u.find({}, {projection:{name:1,email:1,role:1,phone:1}}).toArray();
for (const r of rows) console.log(r.role,'|',r.name,'|',r.phone,'|',r.email);
await mongoose.disconnect();
