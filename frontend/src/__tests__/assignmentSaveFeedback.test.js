import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const code = readFileSync(fileURLToPath(new URL('../pages/student/StudentAssignmentsPage.jsx', import.meta.url)), 'utf8');

describe('student assignment submit/update confirmation', () => {
  it('confirms a successful server-backed save inside the still-open dialog, beside the submit button', () => {
    expect(code).toContain("setSaveSuccess(isNew ? 'Assignment submitted successfully.' : 'Submission updated successfully.')");
    expect(code).toMatch(/\{saveSuccess && \(\s*<Alert[^>]*role="status"[^>]*>\{saveSuccess\}<\/Alert>/);
    expect(code.indexOf('{saveSuccess && (')).toBeGreaterThan(code.indexOf('<form onSubmit={submit}'));
    expect(code.indexOf('{saveSuccess && (')).toBeLessThan(code.indexOf('<Button type="submit" loading={saving}>'));
  });

  it('never starts the behind-modal page flash until the dialog closes, and clears a stale success on edits', () => {
    expect(code).toContain('if (saveSuccess && !saveWarning) onSaved(saveSuccess);');
    expect(code).toContain('<Modal open onClose={closeDetail}');
    expect(code).toContain('setTextAnswer(e.target.value); setSaveSuccess(null);');
    expect(code).not.toMatch(/onSaved\(isNew \?/);
  });

  it('confirms file changes only after the file uploader reports a completed server operation', () => {
    expect(code).toContain("onAttached={() => { refreshSubmission(); setSaveWarning(false); setSaveSuccess('File attached to your submission.'); }}");
    expect(code).toContain("onRemoved={() => { refreshSubmission(); setSaveWarning(false); setSaveSuccess('File removed from your submission.'); }}");
    expect(code).toContain('setSaveWarning(failures.length > 0)');
  });
});
