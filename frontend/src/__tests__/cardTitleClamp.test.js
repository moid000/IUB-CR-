import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * 2026-09-22 (owner screenshot): a long Announcement/Assignment/Note title
 * had NO line-clamp — it wrapped to 6+ lines, making that one card wildly
 * taller than its neighbours (unprofessional, inconsistent list). Every
 * list-card title across student + CR Announcements/Assignments/Notes must
 * stay clamped to 2 lines (the full title is still shown once the card is
 * opened) so every card in a list stays a consistent, predictable height.
 */
describe('list-card titles are clamped to 2 lines (never grow the card unbounded)', () => {
  const pages = [
    'pages/student/StudentAnnouncementsPage.jsx',
    'pages/student/StudentAssignmentsPage.jsx',
    'pages/student/StudentNotesPage.jsx',
    'pages/cr/AnnouncementsPage.jsx',
    'pages/cr/AssignmentsPage.jsx',
    'pages/cr/NotesPage.jsx',
  ];

  it.each(pages)('%s clamps its list-card title to 2 lines', (rel) => {
    const code = src(rel);
    // every title interpolation (a.title / n.title) must sit on a line
    // carrying line-clamp-2 in its className
    const titleLines = code.split('\n').filter((l) => /\{[an]\.title\}/.test(l));
    expect(titleLines.length).toBeGreaterThan(0);
    for (const line of titleLines) {
      expect(line).toContain('line-clamp-2');
    }
  });
});

describe('Student announcement meta row (author · time) is never squeezed by the thumbnail', () => {
  it('the timeAgo meta row sits in its own full-width row, not sharing flex space with the image thumbnail', () => {
    const code = src('pages/student/StudentAnnouncementsPage.jsx');
    // the timestamp <p> and the thumbnail <img> must NOT be inside the same
    // `flex items-start gap-3` row (that's exactly what crushed "14…" in the
    // owner's screenshot) — the meta row must come AFTER that row closes.
    const metaIdx = code.indexOf('{a.author?.name');
    const imgIdx = code.indexOf('thumbUrl(image.url');
    expect(metaIdx).toBeGreaterThan(-1);
    expect(imgIdx).toBeGreaterThan(-1);
    expect(metaIdx).toBeGreaterThan(imgIdx); // meta row rendered after (outside) the thumbnail row
  });
});
