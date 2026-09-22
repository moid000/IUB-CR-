import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * 2026-09-22 owner request: a newly-arrived announcement/assignment/note used
 * to look identical to old cards and opening its tab bulk-cleared the badge.
 * The professional contract is per-item NEW state until that card is opened.
 */
describe('professional per-item NEW content contract', () => {
  const pages = [
    'pages/student/StudentAnnouncementsPage.jsx',
    'pages/student/StudentAssignmentsPage.jsx',
    'pages/student/StudentNotesPage.jsx',
    'pages/cr/AnnouncementsPage.jsx',
    'pages/cr/AssignmentsPage.jsx',
    'pages/cr/NotesPage.jsx',
  ];

  it.each(pages)('%s uses persistent per-item unread state and NEW styling', (rel) => {
    const code = src(rel);
    expect(code).toContain('useUnreadContent');
    expect(code).toContain('unread.isNew');
    expect(code).toContain('unread.markSeen');
    expect(code).toContain('NewBadge');
    expect(code).toContain('NewRail');
  });

  it('tab landing never bulk-clears notifications anymore', () => {
    for (const rel of ['student/StudentLayout.jsx', 'cr/CrLayout.jsx']) {
      const code = src(rel);
      expect(code).not.toContain('readByType(clearTypes)');
      expect(code).toContain('tri3m:notifications-changed');
    }
  });

  it('shared hook marks only the opened notification and updates shell badges', () => {
    const code = src('hooks/useUnreadContent.js');
    expect(code).toContain('notificationsApi.read(notification._id)');
    expect(code).toContain("CustomEvent('tri3m:notifications-changed')");
    expect(code).toContain("get('focus')");
  });

  it('both API clients use the secure content-ref endpoint', () => {
    expect(src('api/student.js')).toContain('/notifications/unread-content-refs?type=');
    expect(src('api/cr.js')).toContain('/notifications/unread-content-refs?type=');
  });
});
