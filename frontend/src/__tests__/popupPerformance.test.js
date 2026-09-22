import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * 2026-09-22 owner report: reading Announcement/Note/Assignment popups felt
 * very slow because the click blanked known card data, rendered a skeleton,
 * then waited for another API round-trip. Contract: known card content paints
 * immediately; freshness and submission data hydrate behind it.
 */
describe('read popups use instant list data, never block on a duplicate detail GET', () => {
  it.each([
    ['pages/student/StudentAnnouncementsPage.jsx', 'announcements.get'],
    ['pages/student/StudentNotesPage.jsx', 'notes.get'],
  ])('%s paints item first and refreshes silently', (rel, endpoint) => {
    const code = src(rel);
    expect(code).toContain('setDetail(item)');
    expect(code).toContain(endpoint);
    expect(code).toContain('.catch(() => {})');
    expect(code).not.toContain('setDetailLoading(true)');
  });

  it('student assignment opens from initialAssignment and hydrates requests in parallel', () => {
    const code = src('pages/student/StudentAssignmentsPage.jsx');
    expect(code).toContain('initialAssignment={items.find');
    expect(code).toContain('useState(initialAssignment)');
    expect(code).toContain('Promise.allSettled([assignmentRequest, submissionRequest])');
    expect(code).toContain('submissionLoading ? null : locked');
  });
});

describe('popup motion and image delivery are optimized globally', () => {
  it('modal has no rise animation and settles within 120ms', () => {
    const code = src('components/ui/Modal.jsx');
    expect(code).not.toContain('y: 10');
    expect(code).toContain('duration: 0.12');
  });

  it('every announcement/note/assignment list warms modal thumbnails', () => {
    const pages = [
      'pages/student/StudentAnnouncementsPage.jsx',
      'pages/student/StudentAssignmentsPage.jsx',
      'pages/student/StudentNotesPage.jsx',
      'pages/cr/AnnouncementsPage.jsx',
      'pages/cr/AssignmentsPage.jsx',
      'pages/cr/NotesPage.jsx',
    ];
    for (const rel of pages) expect(src(rel)).toContain('useAttachmentPrefetch(items)');
  });

  it('prefetch is tiny-thumbnail-only and respects save-data/2G', () => {
    const code = src('hooks/useAttachmentPrefetch.js');
    expect(code).toContain('thumbUrl(file.url, 96)');
    expect(code).toContain('connection?.saveData');
    expect(code).toContain('requestIdleCallback');
    expect(code).not.toContain('previewUrl');
  });
});
