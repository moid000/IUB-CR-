/**
 * Password requirement checklist — mirrors the backend policy exactly
 * (8–128 chars, lower, upper, number, special). Backend stays authoritative;
 * this is guidance only, not a client-side security assumption.
 */
const RULES = [
  { key: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 && p.length <= 128 },
  { key: 'lower', label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { key: 'upper', label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { key: 'number', label: 'A number', test: (p) => /[0-9]/.test(p) },
  { key: 'special', label: 'A special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export function passwordMeetsPolicy(pw) {
  return RULES.every((r) => r.test(pw));
}

export function PasswordChecklist({ password = '' }) {
  if (!password) return null;
  return (
    <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Password requirements">
      {RULES.map((r) => {
        const ok = r.test(password);
        return (
          <li
            key={r.key}
            className={`flex items-center gap-1.5 text-xs transition-colors ${ok ? 'text-emerald-600' : 'text-slate-400'}`}
          >
            <svg className="size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              {ok
                ? <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 0 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clipRule="evenodd" />
                : <circle cx="10" cy="10" r="8" className="opacity-20" fill="currentColor" />}
            </svg>
            <span>{r.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
