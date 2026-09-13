/**
 * Safe user projection for API responses.
 * NEVER includes: password, passwordHash, OTP data, audit internals.
 */
export function publicUser(user) {
  const u = user && user.toObject ? user.toObject() : user || {};
  return {
    id: u._id ?? null,
    name: u.name ?? null,
    email: u.email ?? null,
    phone: u.phone ?? null,
    role: u.role ?? null,
    section: u.section ?? null,
    rollNo: u.rollNo ?? '',
    registrationStatus: u.registrationStatus ?? null,
    emailVerified: u.emailVerified ?? false,
    activationAt: u.activationAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
  };
}

/** Safe populated section payload for /auth/me. */
export function publicSection(section) {
  if (!section) return null;
  const s = section.toObject ? section.toObject() : section;
  return {
    id: s._id ?? null,
    name: s.name ?? null,
    semester: s.semester ?? null,
    status: s.status ?? null,
    department: s.department ?? null,
    session: s.session ?? null,
  };
}
