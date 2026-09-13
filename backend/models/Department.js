import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Admin-managed department registry. Archiving is preferred over deletion. */
const departmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

// Case-insensitive unique name ("AI" and "ai" collide → duplicate impossible)
departmentSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
departmentSchema.index({ code: 1 }, { unique: true });
departmentSchema.index({ status: 1 });

export default mongoose.model('Department', departmentSchema);
