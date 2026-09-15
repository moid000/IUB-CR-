import crypto from 'node:crypto';
import { Announcement, Note, Assignment, Submission, Section, User } from '../models/index.js';
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
// mime may be a string or an array of accepted variants (browsers disagree
// on several audio/video/archive MIME labels, e.g. audio/wav vs audio/x-wav).
const ALLOWED_TYPES = [
  { ext: 'pdf',  mime: 'application/pdf',                                                resourceType: 'raw' },
  { ext: 'png',  mime: 'image/png',                                                      resourceType: 'image' },
  { ext: 'jpg',  mime: 'image/jpeg',                                                    resourceType: 'image' },
  { ext: 'jpeg', mime: 'image/jpeg',                                                    resourceType: 'image' },
  { ext: 'webp', mime: 'image/webp',                                                     resourceType: 'image' },
  { ext: 'gif',  mime: 'image/gif',                                                      resourceType: 'image' },
  { ext: 'doc',  mime: 'application/msword',                                            resourceType: 'raw' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',  resourceType: 'raw' },
  { ext: 'ppt',  mime: 'application/vnd.ms-powerpoint',                                 resourceType: 'raw' },
  { ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', resourceType: 'raw' },
  { ext: 'xls',  mime: 'application/vnd.ms-excel',                                      resourceType: 'raw' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       resourceType: 'raw' },
  { ext: 'txt',  mime: 'text/plain',                                                    resourceType: 'raw' },
  { ext: 'csv',  mime: 'text/csv',                                                      resourceType: 'raw' },
  { ext: 'rtf',  mime: ['application/rtf', 'text/rtf'],                                 resourceType: 'raw' },
  { ext: 'zip',  mime: ['application/zip', 'application/x-zip-compressed'],             resourceType: 'raw' },
  { ext: 'rar',  mime: ['application/vnd.rar', 'application/x-rar-compressed', 'application/rar'], resourceType: 'raw' },
  { ext: '7z',   mime: 'application/x-7z-compressed',                                  resourceType: 'raw' },
  { ext: 'mp3',  mime: 'audio/mpeg',                                                    resourceType: 'raw' },
  { ext: 'wav',  mime: ['audio/wav', 'audio/x-wav'],                                    resourceType: 'raw' },
  { ext: 'm4a',  mime: ['audio/mp4', 'audio/x-m4a'],                                    resourceType: 'raw' },
  { ext: 'ogg',  mime: ['audio/ogg', 'application/ogg'],                                 resourceType: 'raw' },
  { ext: 'aac',  mime: ['audio/aac', 'audio/x-aac'],                                    resourceType: 'raw' },
  { ext: 'flac', mime: 'audio/flac',                                                    resourceType: 'raw' },
  { ext: 'mp4',  mime: 'video/mp4',                                                      resourceType: 'raw' },
  { ext: 'mkv',  mime: 'video/x-matroska',                                              resourceType: 'raw' },
  { ext: 'mov',  mime: ['video/quicktime', 'video/x-quicktime'],                        resourceType: 'raw' },
  { ext: 'avi',  mime: ['video/x-msvideo', 'video/avi'],                                resourceType: 'raw' },
  { ext: 'webm', mime: ['video/webm', 'audio/webm'],                                     resourceType: 'raw' },
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
  const match = ALLOWED_TYPES.find((t) => t.ext === ext
    && (t.mime === mime || (Array.isArray(t.mime) && t.mime.includes(mime))));
  if (!match) {
    throw new ApiError(400, 'Unsupported file type');
  }
  return match;
}

function folderFor(parentType, parentId) {
  return `${NAMESPACE}/${parentType}/${String(parentId)}`;
}

function publicIdFor(parentType, parentId) {
  // BASENAME ONLY — Cloudinary prepends the `folder` param to public_id on
  // upload, so the final asset id is folder + '/' + basename. Prefixing the
  // folder here would double the path and break confirm validation.
  // The parentId segment keeps the namespace self-describing so confirmation
  // can verify parent binding.
  return `${parentType}-${parentId}-${crypto.randomBytes(6).toString('hex')}`;
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
  // Cloudinary returns folder:null when public_id carries the full path —
  // the namespace is then proven by the publicId prefix checks below.
  if (folder && folder !== expectedFolder) await reject('folder_mismatch');
  if (!publicId.startsWith(`${expectedFolder}/`)) await reject('publicId_mismatch');
    const suffix = publicId.slice(expectedFolder.length + 1);
  // raw uploads: Cloudinary APPENDS the extension to public_id (…-<hex>.pdf)
  // and omits `format` — split the tail off so the pattern check stays exact.
  const dot = suffix.lastIndexOf('.');
  const ext = dot > -1 ? suffix.slice(dot + 1).toLowerCase() : '';
  const baseSuffix = ext ? suffix.slice(0, dot) : suffix;
  if (!new RegExp(`^${parentType}-[0-9a-f]{24}-${PUBLIC_ID_RE.source.replace(/^\^|\$$/g, '')}$`).test(baseSuffix)) {
    await reject('publicId_pattern');
  }

  // 2. format ↔ resource_type from the allowlist
  // images carry `format`; raw files don't — derive it from the public_id tail
  const effFormat = format || ext;
  const type = ALLOWED_TYPES.find((t) => t.ext === effFormat && t.resourceType === resourceType);
  if (!type) await reject('type_not_allowed');

  // 3. HTTPS URL on OUR Cloudinary account, pointing at this exact asset
  const accountPrefix = `https://res.cloudinary.com/${cloudName}/`;
  if (!secureUrl.startsWith(accountPrefix)) await reject('url_not_account');
  // real delivery URLs carry a version segment (/upload/v<digits>/) — normalize
  // it away so the URL is compared to the exact asset path
  const normalizedUrl = secureUrl.replace(/\/upload\/v\d+\//, '/upload/');
  // raw assets: public_id ALREADY ends with the extension and format is null
  const expectedUrlSuffix = `/upload/${publicId}${format ? '.' + format : ''}`;
  if (!normalizedUrl.endsWith(expectedUrlSuffix)) await reject('url_asset_mismatch');

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
  let originalName = rawName.slice(Math.max(0, rawName.lastIndexOf('/') + 1)).slice(0, 255) || `upload.${effFormat}`;
  // raw uploads come back with the extension STRIPPED from original_filename —
  // restore it so the UI shows "notes.pdf", not "notes"
  if (effFormat && !originalName.toLowerCase().endsWith('.' + effFormat)) {
    originalName = `${originalName}.${effFormat}`.slice(0, 255);
  }

  const fileMeta = {
    publicId,
    url: secureUrl,             // verified HTTPS, our account, this asset
    resourceType,
    format: effFormat,
    mimeType: Array.isArray(type.mime) ? type.mime[0] : type.mime,
    folder: folder || expectedFolder,
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

/* ============================ STEP 18 — removal ========================== */

/**
 * POST /api/<role>/files/remove
 * Detaches a CONFIRMED attachment from its parent (scoped by loadParent's
 * role matrix) and best-effort destroys the Cloudinary asset. The destroy
 * call is signed with the apiSecret server-side and NEVER blocks the API
 * response on network failure (the DB removal is the authoritative part).
 */
export async function removeAttachment(req) {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const parentType = v.assertEnum(String(req.body?.parentType ?? ''), Object.keys(SUPPORTED_PARENTS), 'parentType');
  const publicId = String(req.body?.publicId ?? '').trim();
  const { parent, def, id } = await loadParent(req, parentType, req.body?.parentId);
  const field = def.field;

  const current = parent[field] ?? [];
  const target = current.find((f) => f.publicId === publicId);
  if (!target) throw new ApiError(404, 'Attachment not found');

  // Students may only remove their OWN submission files — loadParent already
  // guarantees parent ownership; here the file must also belong to the caller
  // (a CR cannot strip a file another CR confirmed — impossible cross-section,
  // but a student's submission could theoretically hold a file confirmed by
  // someone else; that case is denied too, by construction below).
  if (req.user.role === 'student' && String(target.uploadedBy ?? '') !== String(req.user._id)) {
    throw new ApiError(403, 'You can only remove your own files');
  }

  const updated = await def.Model.findOneAndUpdate(
    { _id: id, [`${field}.publicId`]: publicId },
    { $pull: { [field]: { publicId } } },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'Attachment not found');

  await auditFromReq(req, {
    action: 'file.upload.remove', entityType: parentType, entityId: id,
    section: parent.section, after: { parentType, publicId }, // metadata only
  });

  // Best-effort Cloudinary destroy — failures never surface internals.
  destroyAsset({ cloudName, apiKey, apiSecret, publicId }).catch(() => {});
  return { removed: true };
}

/**
 * Signed Cloudinary destroy call. The signature uses the same official sha1
 * scheme; the apiSecret never crosses the API boundary.
 */
export function destroyAsset({ cloudName, apiKey, apiSecret, publicId }) {
  const timestamp = Math.floor(now() / 1000);
  const signature = cloudinarySignature({ public_id: publicId, timestamp }, apiSecret);
  const body = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: apiKey, signature });
  return fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/* ============================ STEP 18 — avatar =========================== */

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB — avatars only
const AVATAR_TYPES = ALLOWED_TYPES.filter((t) => t.resourceType === 'image');

function avatarFolder(userId) {
  return `${NAMESPACE}/avatar/${String(userId)}`;
}

function avatarPublicId(userId) {
  // BASENAME ONLY — Cloudinary prepends the folder on upload (see publicIdFor).
  return `avatar-${String(userId)}-${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * POST /api/auth/avatar/sign — any authenticated user, self ONLY.
 * The client never supplies userId/folder/publicId; everything derives from
 * req.user. Images only, 5 MB max.
 */
export async function signAvatarUpload(req) {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const userId = String(req.user._id);
  const type = assertTypePair(req.body?.file?.originalName, req.body?.file?.mimeType);
  if (type.resourceType !== 'image') throw new ApiError(400, 'Profile pictures must be PNG, JPG, JPEG or WEBP');

  const timestamp = Math.floor(now() / 1000);
  const folder = avatarFolder(userId);
  const publicId = avatarPublicId(userId);
  const signature = cloudinarySignature({ folder, public_id: publicId, timestamp }, apiSecret);

  await auditFromReq(req, {
    action: 'avatar.upload.signature', entityType: 'user', entityId: userId,
    after: { resourceType: 'image' },
  });

  return {
    cloudName, apiKey, timestamp, signature, folder, publicId,
    resourceType: 'image',
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    maxSizeBytes: MAX_AVATAR_BYTES,
  };
}

/**
 * POST /api/auth/avatar/confirm — verifies the upload against the SAME
 * invariants as academic files, then atomically REPLACES req.user.avatar.
 * Replacing an existing avatar destroys the superseded asset (best-effort).
 */
export async function confirmAvatarUpload(req) {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const userId = String(req.user._id);

  const result = req.body?.result ?? {};
  const publicId = String(result.public_id ?? '').trim();
  const folder = String(result.folder ?? '').trim();
  const secureUrl = String(result.secure_url ?? '').trim();
  const resourceType = String(result.resource_type ?? '').trim().toLowerCase();
  const format = String(result.format ?? '').trim().toLowerCase();
  const bytes = Number(result.bytes);

  const expectedFolder = avatarFolder(userId);
  const reject = async (reason) => {
    await auditFromReq(req, {
      action: 'avatar.upload.reject', entityType: 'user', entityId: userId, reason,
    });
    throw new ApiError(400, 'Invalid upload result');
  };

  // Cloudinary returns folder:null when public_id carries the full path —
  // the namespace is then proven by the publicId prefix checks below.
  if (folder && folder !== expectedFolder) await reject('folder_mismatch');
  if (!publicId.startsWith(`${expectedFolder}/`)) await reject('publicId_mismatch');
  const suffix = publicId.slice(expectedFolder.length + 1);
  if (!new RegExp(`^avatar-${userId}-${PUBLIC_ID_RE.source.replace(/^\^|\$$/g, '')}$`).test(suffix)) {
    await reject('publicId_pattern');
  }

  const type = AVATAR_TYPES.find((t) => t.ext === format);
  if (!type || resourceType !== 'image') await reject('type_not_allowed');

  const accountPrefix = `https://res.cloudinary.com/${cloudName}/`;
  if (!secureUrl.startsWith(accountPrefix)) await reject('url_not_account');
  // real delivery URLs carry a version segment (/upload/v<digits>/) — normalize
  const normalizedUrl = secureUrl.replace(/\/upload\/v\d+\//, '/upload/');
  if (!normalizedUrl.endsWith(`/upload/${publicId}.${format}`)) await reject('url_asset_mismatch');

  if (!Number.isFinite(bytes) || bytes <= 0) await reject('missing_size');
  if (bytes > MAX_AVATAR_BYTES) await reject('file_too_large');

  const rawName = String(result.original_filename ?? '').trim();
  const originalName = rawName.slice(Math.max(0, rawName.lastIndexOf('/') + 1)).slice(0, 255) || `avatar.${format}`;

  const fileMeta = {
    publicId, url: secureUrl, resourceType: 'image', format,
    mimeType: type.mime, folder: folder || expectedFolder, originalName, size: bytes,
    uploadedBy: req.user._id,
  };

  // capture the SUPPLANTED avatar first (replaced asset = cleanup target)
  const before = await User.findById(req.user._id).select('avatar');
  const superseded = before?.avatar?.publicId ?? null;

  const updated = await User.findOneAndUpdate(
    { _id: req.user._id },
    { $set: { avatar: fileMeta } },
    { new: true },
  );
  if (!updated) throw new ApiError(404, 'Account no longer exists');

  await auditFromReq(req, {
    action: 'avatar.upload.confirm', entityType: 'user', entityId: userId,
    after: { format, size: bytes, publicId }, // metadata only — never secrets
  });

  // best-effort cleanup of the superseded asset (never the new one)
  if (superseded && superseded !== publicId) {
    destroyAsset({ cloudName, apiKey, apiSecret, publicId: superseded }).catch(() => {});
  }

  return {
    avatar: {
      url: secureUrl, format, size: bytes, originalName,
      uploadedAt: now(),
    },
  };
}

/**
 * DELETE /api/auth/avatar — self-service removal (avatar → null).
 * Best-effort destroys the Cloudinary asset afterwards.
 */
export async function removeAvatar(req) {
  const { cloudName, apiKey, apiSecret } = getConfig();
  const user = await User.findById(req.user._id).select('avatar');
  const existing = user?.avatar;
  if (!existing) throw new ApiError(404, 'No profile picture to remove');

  await User.findOneAndUpdate(
    { _id: req.user._id, 'avatar.publicId': existing.publicId },
    { $set: { avatar: null } },
  );

  await auditFromReq(req, {
    action: 'avatar.remove', entityType: 'user', entityId: String(req.user._id),
    after: { publicId: existing.publicId },
  });

  destroyAsset({ cloudName, apiKey, apiSecret, publicId: existing.publicId }).catch(() => {});
  return { removed: true };
}
