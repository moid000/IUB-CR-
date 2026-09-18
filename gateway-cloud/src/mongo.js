import mongoose from 'mongoose';

/** Serverless-safe Mongo connection (per warm container, reused across invocations). */
export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
  });
}
