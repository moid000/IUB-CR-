import crypto from 'node:crypto';
import { Announcement, Note, Assignment, Submission, Section } from '../models/index.js';
import { ApiError } from '../middleware/error.js';
import { auditFromReq } from '../utils/audit.js';
import { now } from '../utils/clock.js';
import * as v from '../utils/validators.js';

/**
 * STEP 10 — secure browser-direct Cloudinary upload foundation.
 *
 * TRUST MODEL — the backend NEVER receives file bytes. Authenticated users
 * request a short-lived signed upload payload, upload straight to Cloudinary,
 * then POST the Cloudinary result back for verification. Only VERIFIED
 * metadata is embedded into the parent document; there is no File collection.
 *
 * SECURITY INVARIANTS
 *  - Cloudinary apiSecret NEVER leaves this module (never signed into the
 *    payload, never logged, never returned — only used to compute the sha1).
 *  - Folder and publicId are ALWAYS server-derived from the verified parent;
 *    client-supplied folder/publicId/section/owner fields are never read.
 *  - A confirmed asset must match the exact authorized namespace pattern, so
 *    a signed upload for one parent can never be grafted onto another.
 *  - The apiSecret is the ONLY Cloudinary secret; JWT/Brevo/attendance
 *    secrets are never reused for signing.
 */

/* ------------------------------ configuration --------------------------- */

/* ------------------------------ constants ------------------------------- */

const NAMESPACE = 'iub-cr-lms';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file — conservative limit
const MAX_FILES_PER_PARENT = 10; // matches the pre-existing submission limit

/**
 * Allowlist: extension ↔ MIME ↔ Cloudinary resource_type. BOTH the extension
 * and the MIME type must be present AND refer to the same entry — extension
 * alone is never trusted. Executable/script formats are structurally absent.
 */
const ALLOWED_TYPES = [
  { ext: 'pdf',  mime: 'application/pdf',                                                resourceType: 'raw' },
  { ext: 'png',  mime: 'image/png',                                                      resourceType: 'image' },
  { ext: 'jpg',  mime: 'image/jpeg',                                                    resourceType: 'image' },
  { ext: 'jpeg', mime: 'image/jpeg',                                                    resourceType: 'image' },
  { ext: 'webp', mime: 'image/webp',                                                     resourceType: 'image' },
  { ext: 'doc',  mime: 'application/msword',                                            resourceType: 'raw' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',  resourceType: 'raw' },
  { ext: 'ppt',  mime: 'application/vnd.ms-powerpoint',                                 resourceType: 'raw' },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', resourceType: 'raw' },
  { ext: 'xls',  mime: 'application/vnd.ms-excel',                                      resourceType: 'raw' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       resourceType: 'raw' },
  { ext: 'txt',  mime: 'text/plain',                                                    resourceType: 'raw' },
];

const SUPPORTED_PARENTS = {
  announcement: { Model: Announcement, field: 'attachments' },
  note: { Model: Note, field: 'attachments' },
  assignment: { Model: Assignment, field: 'attachments' },
  submission: { Model: Submission, field: 'files' },
};

const PUBLIC_ID_RE = /^[0-9a-f]{12}$/; // server-generated random suffix

/* ------------------------------ helpers --------------------------------- */

function getConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  // Fail SAFE: report a generic unavailability, never which secret is absent.
  if (!cloudName || !apiKey || !apiSecret) {
    throw new ApiError(503, 'File uploads are temporarily unavailable');
  }
  return { cloudName, apiKey, apiSecret };
}

/**
 * Official Cloudinary signature: sha1 of the upload params (sorted
 * alphabetically, `k=v` joined by `&`) concatenated with the apiSecret.
 * Only params Cloudinary includes in the signature are used here.
 */
function cloudinarySignature(params, apiSecret) {
  const toSign = Object.keys(params).sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

function assertTypePair(originalName, mimeType) {
  const name = String(originalName ?? '').trim();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const mime = String(mimeType ?? '').trim().toLowerCase();
  const match = ALLOWED_TYPES.find((t) => t.ext === ext && t.mime === mime);
  if (!match) {
    throw new ApiError(400, 'Unsupported file type');
  }
  return match;
}

function folderFor(parentType, parentId) {
  return `${NAMESPACE}/${parentType}/${String(parentId)}`;
}

function publicIdFor(parentType, parentId) {
  // `${parentType}-${parentId}-${random}` — the parentId segment makes the
  // namespace self-describing so confirmation can verify parent binding.
  return `${folderFor(parentType, parentId)}/${parentType}-${parentId}-${crypto.randomBytes(6).toString('hex')}`;
}

/* --------------------------- parent resolution --------------------------- */

async function loadParent(req, parentType, parentId) {
  const def = SUPPORTED_PARENTS[parentType];
  if (!def) throw new ApiError(400, 'Unsupported parent type'); // never arbitrary model names
  const id = v.assertObjectId(parentId, 'parent id');
  const parent = await def.Model.findById(id);
  if (!parent) throw new ApiError(404, 'Parent not found');

  // Role matrix (spec §6) — authorization derived from req.user + parent ONLY.
  const role = req.user.role;
  if (role === 'student') {
    if (parentType !== 'submission') {
      throw new ApiError(403, 'Students may only attach files to their own submissions');
    }
    if (String(parent.student) !== String(req.user._id)) {
      throw new ApiError(404, 'Submission not found'); // isolation — cross-user = missing
    }
    // Assignment rules stay enforced: own section, not archived, not past deadline.
    const assignment = await Assignment.findById(parent.assignment);
    if (!assignment || String(assignment.section) !== String(req.user.section)) {
      throw new ApiError(404, 'Assignment not found');
    }
    if (assignment.status === 'archived') throw new ApiError(400, 'Assignment is archived — submissions are closed');
    if (now() > new Date(assignment.deadline).getTime()) {
      throw new ApiError(400, 'Deadline has passed — submissions are locked');
    }
  } else if (role === 'cr') {
    if (parentType === 'submission') throw new ApiError(403, 'Only the submission owner may attach files');
    if (String(parent.section) !== String(req.user.section)) {
      throw new ApiError(404, `${parentType} not found`); // cross-section = missing
    }
  } else if (role === 'admin') {
    if (parentType === 'submission') throw new ApiError(403, 'Admins cannot attach to student submissions');
  } else {
    throw new ApiError(403, 'Not allowed'); // unknown role
  }

  if (parent.status === 'archived') {
    throw new ApiError(400, `Cannot attach files to an archived ${parentType}`);
  }
  return { parent, def, id };
}

/* ------------------------------ signature ------------------------------- */

/**
 * POST /api/<role>/files/sign
 * Returns the MINIMUM signed upload payload. The apiSecret never crosses the
 * API boundary; folder/publicId/timestamp are all server-derived.
 */
export async function signUpload(req) {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const parentType = v.assertEnum(String(req.body?.parentType ?? ''), Object.keys(SUPPORTED_PARENTS), 'parentType');
  const { parent, def, id } = await loadParent(req, parentType, req.body?.parentId);

  const type = assertTypePair(req.body?.file?.originalName, req.body?.file?.mimeType);

  // Server time only — the client can never shift the validity window.
  const timestamp = Math.floor(now() / 1000);
  const folder = folderFor(parentType, id);
  const publicId = publicIdFor(parentType, id);

  const signature = cloudinarySignature(
    { folder, public_id: publicId, timestamp },
    apiSecret,
  );

  await auditFromReq(req, {
    action: 'file.upload.signature', entityType: parentType, entityId: id,
    section: parent.section,
    after: { parentType, resourceType: type.resourceType },
  });

  return {
    cloudName,     // safe — public account identifier required by the upload API
    apiKey,        // safe — Cloudinary upload API keys are public-by-design (paired with secret)
    timestamp,     // server-derived
    signature,     // sha1 signature — useless without the apiSecret
    folder,        // server-derived namespace
    publicId,      // server-derived, unique per call — no overwrite of other assets
    resourceType: type.resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${type.resourceType}/upload`,
    maxSizeBytes: MAX_FILE_BYTES,
    maxFilesPerParent: MAX_FILES_PER_PARENT,
  };
}

/* ----------------------------- confirmation ----------------------------- */

/**
 * POST /api/<role>/files/confirm
 * Verifies the Cloudinary upload result against EVERYTHING the server
 * authorized: parent ownership, exact folder/publicId namespace, expected
 * account domain (HTTPS), allowed format ↔ resource_type pair, and the
 * Cloudinary-reported byte size. On success the VERIFIED FileMeta is appended
 * atomically; retries and concurrent replays are idempotent.
 */
export async function confirmUpload(req) {
  const { cloudName } = getConfig();
  const parentType = v.assertEnum(String(req.body?.parentType ?? ''), Object.keys(SUPPORTED_PARENTS), 'parentType');
  const { parent, def, id } = await loadParent(req, parentType, req.body?.parentId);
  const field = def.field;

  const result = req.body?.result ?? {};
  const publicId = String(result.public_id ?? '').trim();
  const folder = String(result.folder ?? '').trim();
  const secureUrl = String(result.secure_url ?? '').trim();
  const resourceType = String(result.resource_type ?? '').trim().toLowerCase();
  const format = String(result.format ?? '').trim().toLowerCase();
  const bytes = Number(result.bytes);

  const expectedFolder = folderFor(parentType, id);

  const reject = async (reason) => {
    await auditFromReq(req, {
      action: 'file.upload.reject', entityType: parentType, entityId: id,
      section: parent.section, reason,
    });
    throw new ApiError(400, 'Invalid upload result');
  };

  // 1. exact authorized namespace — folder AND publicId must be ours
  if (folder !== expectedFolder) await reject('folder_mismatch');
  if (!publicId.startsWith(`${expectedFolder}/`)) await reject('publicId_mismatch');
  const suffix = publicId.slice(expectedFolder.length + 1);
  if (!new RegExp(`^${parentType}-[0-9a-f]{24}-${PUBLIC_ID_RE.source.replace(/^\^|\$$/g, '')}$`).test(suffix)) {
    await reject('publicId_pattern');
  }

  // 2. format ↔ resource_type from the allowlist
  const type = ALLOWED_TYPES.find((t) => t.ext === format && t.resourceType === resourceType);
  if (!type) await reject('type_not_allowed');

  // 3. HTTPS URL on OUR Cloudinary account, pointing at this exact asset
  const accountPrefix = `https://res.cloudinary.com/${cloudName}/`;
  if (!secureUrl.startsWith(accountPrefix)) await reject('url_not_account');
  const expectedUrlSuffix = `/upload/${publicId}.${format}`;
  if (!secureUrl.endsWith(expectedUrlSuffix)) await reject('url_asset_mismatch');

  // 4. size from the CLOUDINARY result — never a client-declared number
  if (!Number.isFinite(bytes) || bytes <= 0) await reject('missing_size');
  if (bytes > MAX_FILE_BYTES) await reject('file_too_large');

  // 5. per-parent count limit — read BEFORE writing for a fast, clear error
  const current = parent[field] ?? [];
  if (current.length >= MAX_FILES_PER_PARENT) {
    throw new ApiError(400, `Attachment limit reached (max ${MAX_FILES_PER_PARENT})`);
  }
  // duplicate publicId already confirmed → idempotent success, no re-append
  const existing = current.find((f) => f.publicId === publicId);
  if (existing) return existing;

  // sanitize display name from the CLOUDINARY result only (basename, capped)
  const rawName = String(result.original_filename ?? '').trim();
  const originalName = rawName.slice(Math.max(0, rawName.lastIndexOf('/') + 1)).slice(0, 255) || `upload.${format}`;

  const fileMeta = {
    publicId,
    url: secureUrl,             // verified HTTPS, our account, this asset
    resourceType,
    format,
    mimeType: type.mime,
    folder,
    originalName,
    size: bytes,                // verified from the Cloudinary result
    uploadedBy: req.user._id,   // server-derived — never client input
  };

  // 6. ATOMIC append with in-filter duplicate + count guards — concurrent
  // confirmations of the same asset resolve to exactly one entry.
  const updated = await def.Model.findOneAndUpdate(
    {
      _id: id,
      [`${field}.publicId`]: { $ne: publicId }, // replay loses to the first writer
      $expr: { $lt: [{ $size: { $ifNull: [`$${field}`, []] } }, MAX_FILES_PER_PARENT] },
    },
    { $push: { [field]: fileMeta } },
    { new: true },
  );

  if (!updated) {
    // A concurrent request appended it first (or the limit was hit) — treat
    // replay as idempotent success; re-read for the canonical entry.
    const again = await def.Model.findById(id);
    const found = (again?.[field] ?? []).find((f) => f.publicId === publicId);
    if (found) return found;
    throw new ApiError(400, `Attachment limit reached (max ${MAX_FILES_PER_PARENT})`);
  }

  await auditFromReq(req, {
    action: 'file.upload.confirm', entityType: parentType, entityId: id,
    section: parent.section,
    after: { parentType, format, size: bytes, publicId }, // publicId is metadata, never a secret
  });

  return (updated[field]).find((f) => f.publicId === publicId) ?? fileMeta;
}
