const SIZES = { sm: 'size-4', md: 'size-6', lg: 'size-8' };
export function Spinner({ size = 'md', className = '' }) {
  return (
    <svg className={`animate-spin text-primary-600 ${SIZES[size] ?? SIZES.md} ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}
