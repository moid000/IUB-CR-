import mongoose from 'mongoose';

const { Schema } = mongoose;
const { ObjectId } = Schema.Types;

/** Minimal copies of the Tri3M backend schemas — only the fields the sweep reads. */

const FileMetaSchema = new Schema(
  {
    publicId: String,
    url: String,
    resourceType: String,
    format: String,
    mimeType: String,
    originalName: String,
    size: Number,
  },
  { _id: true }
);

const assignmentSchema = new Schema(
  {
    title: { type: String },
    subject: { type: ObjectId, ref: 'Subject' },
    section: { type: ObjectId, ref: 'Section' },
    deadline: { type: Date },
    status: { type: String },
    deadlineNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'assignments' }
);

const submissionSchema = new Schema(
  {
    assignment: { type: ObjectId, ref: 'Assignment' },
    student: { type: ObjectId, ref: 'User' },
    textAnswer: String,
    files: [FileMetaSchema],
    isLate: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'submissions' }
);

const teacherSchema = new Schema(
  {
    name: { type: String },
    subject: { type: ObjectId, ref: 'Subject' },
    section: { type: ObjectId, ref: 'Section' },
    whatsapp: { type: String },
  },
  { timestamps: true, collection: 'teachers' }
);

const subjectSchema = new Schema(
  {
    name: String,
    code: String,
  },
  { collection: 'subjects' }
);

const sectionSchema = new Schema(
  {
    name: { type: String },
    semester: { type: Number },
    department: { type: ObjectId, ref: 'Department' },
    session: { type: ObjectId, ref: 'AcademicSession' },
    cr: { type: ObjectId, ref: 'User' },
    gr: { type: ObjectId, ref: 'User' },
  },
  { collection: 'sections' }
);

const departmentSchema = new Schema({ name: String }, { collection: 'departments' });
const sessionSchema = new Schema({ name: String }, { collection: 'academicsessions' });

const userSchema = new Schema(
  {
    name: String,
    email: String,
    role: String,
    rollNo: String,
    section: { type: ObjectId, ref: 'Section' },
  },
  { collection: 'users' }
);

export const Assignment = mongoose.model('GwAssignment', assignmentSchema);
export const Submission = mongoose.model('GwSubmission', submissionSchema);
export const Teacher = mongoose.model('GwTeacher', teacherSchema);
export const Subject = mongoose.model('GwSubject', subjectSchema);
export const Section = mongoose.model('GwSection', sectionSchema);
export const Department = mongoose.model('GwDepartment', departmentSchema);
export const AcademicSession = mongoose.model('GwSession', sessionSchema);
export const User = mongoose.model('GwUser', userSchema);
