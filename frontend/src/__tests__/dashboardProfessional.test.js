import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Owner request 2026-09-22: dashboard felt simple/unprofessional, but must
 * remain instant. Guard the structural redesign and zero-entry-animation rule. */
describe('student and CR dashboards share professional information hierarchy', () => {
  it.each(['pages/student/StudentOverview.jsx', 'pages/cr/CrOverview.jsx'])(
    '%s has overview, today and latest sections with balanced responsive grids',
    (rel) => {
      const code = src(rel);
      expect(code).toContain('title="At a glance"');
      expect(code).toContain('title="Today"');
      expect(code).toContain('title="Latest"');
      expect(code).toContain('lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]');
      expect(code).toContain('grid-cols-[minmax(0,1fr)]');
      expect(code).toContain('lg:grid-cols-[repeat(2,minmax(0,1fr))]');
      expect((code.match(/<Card className="min-w-0 h-full p-5 sm:p-6">/g) || []).length).toBe(2);
      expect(code).toContain('wideMobile');
      expect(code).not.toContain('Stagger');
      expect(code).not.toContain('FadeIn');
      expect(code).not.toContain('motion.');
    }
  );
});

describe('dashboard hero is branded without mobile-expensive effects', () => {
  const code = src('components/shared/OverviewBits.jsx');

  it('uses one primary gradient, text hierarchy and static CSS depth', () => {
    expect(code).toContain('from-primary-700 via-primary-600 to-primary-500');
    expect(code).toContain('Here’s your section overview for today.');
    expect(code).toContain('DashboardSectionHeader');
    expect(code).not.toContain('blur-');
    expect(code).not.toContain('animate-aurora');
  });

  it('auto-detects Arabic/Urdu direction in both dashboard feed row types', () => {
    expect(code).toMatch(/dir="auto"[^>]*>\{title\}/);
    expect(code).toMatch(/dir="auto"[^>]*>\{content\}/);
  });
});

describe('final mobile metric row is intentional, not a stretched normal tile', () => {
  const code = src('components/ui/StatCard.jsx');
  it('has a dedicated wideMobile layout that returns to uniform desktop rhythm', () => {
    expect(code).toContain('wideMobile = false');
    expect(code).toContain('lg:flex-col');
    expect(code).toContain('lg:min-h-[84px]');
    expect(code).toContain('duration-200');
    expect(code).toContain('line-clamp-2');
    expect(code).not.toContain('truncate text-[10px] font-semibold uppercase');
  });
});
