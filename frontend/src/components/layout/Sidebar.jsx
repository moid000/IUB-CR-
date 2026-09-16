import { NavLink } from 'react-router-dom';

/**
 * Shared sidebar navigation primitives — the single vocabulary for the
 * Admin / CR / Student shells. Same active indicator, same spacing, same
 * collapse behavior; role difference comes from the NAV data, not the styles.
 */

/** Brand lockup used at the top of every sidebar. */
export function SidebarBrand({ to = '/', onClose, showTitle = true }) {
  return (
    <div className={`flex h-16 shrink-0 items-center border-b border-slate-100 ${showTitle ? 'px-5' : 'justify-center px-2'}`}>
      <NavLink to={to} className="flex items-center gap-2.5 rounded-lg py-1" aria-label="T3M (Tri3M)">
        <img src={`${import.meta.env.BASE_URL}logo-256.png`} alt="T3M (Tri3M) logo" className="size-8 shrink-0 rounded-lg object-contain" />
        {showTitle && (
          <span className="truncate text-sm font-semibold tracking-tight text-slate-900">
            T3M (Tri3M)
          </span>
        )}
      </NavLink>
      {onClose && (
        <button
          type="button" onClick={onClose} aria-label="Close navigation menu"
          className="ml-auto rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 lg:hidden"
        >
          <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A single nav item — NavLink with a subtle left active indicator. */
export function NavItem({ to, label, icon: Icon, end, badge, collapsed = false }) {
  return (
    <NavLink
      to={to} end={end} title={label}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors
         ${collapsed ? 'lg:justify-center lg:px-2.5' : ''}
         ${isActive ? 'bg-primary-50/80 text-primary-700' : 'text-slate-600 hover:bg-slate-100/80 hover:text-slate-900'}`
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full rounded-l-none bg-primary-600 transition-all duration-200
              ${isActive ? 'opacity-100' : 'opacity-0'}`}
          />
          <Icon className={`size-4.5 shrink-0 transition-all duration-200 ${isActive ? 'text-primary-600' : 'text-slate-400 group-hover:scale-110 group-hover:text-primary-500'}`} />
          <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
          {badge != null && badge > 0 && (
            <span
              className={`ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-primary-600 px-1.5 text-[11px] font-semibold text-white ${collapsed ? 'lg:hidden' : ''}`}
              aria-label={`${badge} unread notifications`}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/** A titled group of nav items. Labels only show when expanded. */
export function NavGroup({ label, items, collapsed = false, badge }) {
  return (
    <div className="space-y-0.5">
      {label && (
        <p className={`px-3 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-widest text-slate-400 ${collapsed ? 'lg:hidden' : ''}`}>
          {label}
        </p>
      )}
      {items.map((item) => (
        <NavItem key={item.to} {...item} collapsed={collapsed} badge={item.badge ?? badge} />
      ))}
    </div>
  );
}
