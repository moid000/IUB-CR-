import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/**
 * 2026-09-22 owner screenshots: Arabic/Urdu announcement content rendered
 * left-aligned (wrong reading direction for RTL script) and Notes cards had
 * no hover/press feedback unlike Announcements/Assignments cards (visually
 * inconsistent). Both are professional-polish regressions to guard.
 */
describe('user-generated title/content/instructions auto-detect RTL script', () => {
  const targets = [
    ['pages/student/StudentNotesPage.jsx', ['{n.title}', '{n.content}', '{detail.title}', '{detail.content}']],
    ['pages/cr/NotesPage.jsx', ['{n.title}', '{n.content}']],
    ['pages/student/StudentAssignmentsPage.jsx', ['{a.title}', '{a.instructions}', '{assignment.title}', '{assignment.instructions}']],
    ['pages/cr/AssignmentsPage.jsx', ['{a.title}', '{a.instructions}']],
    ['pages/student/StudentAnnouncementsPage.jsx', ['{a.title}', '{a.content}', '{detail.title}', '{detail.content}']],
    ['pages/cr/AnnouncementsPage.jsx', ['{a.title}', '{a.content}']],
  ];

  it.each(targets)('%s marks every listed field dir="auto"', (rel, fields) => {
    const code = src(rel);
    for (const field of fields) {
      const line = code.split('\n').find((l) => l.includes(field));
      expect(line, `${field} in ${rel}`).toBeTruthy();
      expect(line).toContain('dir="auto"');
    }
  });
});

describe('Notes cards match Announcements/Assignments hover + press feel', () => {
  it.each(['pages/student/StudentNotesPage.jsx', 'pages/cr/NotesPage.jsx'])(
    '%s note card lifts on hover and settles on tap, like the other 4 list pages',
    (rel) => {
      const code = src(rel);
      expect(code).toContain('hover:-translate-y-0.5');
      expect(code).toContain('hover:shadow-lift');
      expect(code).toContain('[@media(hover:hover)]:active:scale-[0.99]');
    }
  );
});

describe('Notes subject-chip row signals horizontal scroll at the cut-off edge', () => {
  it('student Notes chip row has an edge fade mask so a partially visible chip reads as scrollable', () => {
    const code = src('pages/student/StudentNotesPage.jsx');
    expect(code).toContain('mask-image:linear-gradient(to_right');
  });
});
