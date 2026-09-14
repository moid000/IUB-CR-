/** Elevated glass-white card — the base surface of the design system. */
export function Card({ as: Tag = 'div', className = '', children, ...rest }) {
  return (
    <Tag
      className={`rounded-2xl border border-slate-200/70 bg-white/80 shadow-soft backdrop-blur-sm ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  );
}
