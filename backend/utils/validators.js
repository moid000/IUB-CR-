import { ApiError } from '../middleware/error.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9]{10,15}$/;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
export const isValidObjectId = (value) => OBJECT_ID_RE.test(String(value ?? ''));

export function assertObjectId(value, field = 'id') {
  if (!isValidObjectId(value)) throw new ApiError(400, `Invalid ${field}`);
  return String(value).trim();
}

export function assertEmail(value, field = 'email') {
  const email = normalizeEmail(value);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new ApiError(400, `Invalid ${field}`);
  }
  return email;
}

export function assertPassword(value, field = 'password') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new ApiError(400, `${field} must be 8–128 characters`);
  }
  return value;
}

export function assertName(value, field = 'name') {
  const name = String(value ?? '').trim();
  if (name.length < 2 || name.length > 100) {
    throw new ApiError(400, `Invalid ${field} (2–100 characters required)`);
  }
  return name;
}

export function assertPhone(value, field = 'phone') {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const phone = String(value).replace(/[\s-]/g, '');
  if (!PHONE_RE.test(phone)) throw new ApiError(400, `Invalid ${field}`);
  return phone;
}

export function assertSemester(value) {
  const semester = Number(value);
  if (!Number.isInteger(semester) || semester < 1 || semester > 8) {
    throw new ApiError(400, 'Semester must be an integer between 1 and 8');
  }
  return semester;
}

export function assertDate(value, field = 'date') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `Invalid ${field}`);
  return date;
}

export function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ApiError(400, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/** Whitelists request-body fields — protected fields can never be overridden. */
export function pick(body, keys) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}
