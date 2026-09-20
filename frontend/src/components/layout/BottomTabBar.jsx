import { NavLink } from 'react-router-dom';
import { IconMenu } from '../icons.jsx';

/**
 * Mobile-only bottom tab bar (hidden from lg up, where the sidebar rail lives).
 * Gives the 4 most-used pages thumb-reach navigation; "More" opens the same
 * Motion drawer as the hamburger. Professional app pattern (WhatsApp/Instagram).
 *
 * Props:
 *  - items: [{ to, label, icon, end? }]
 *  - onMore: opens the portal drawer
 *  - moreBadge: optional unread count shown as a dot on the More button
 */
export function BottomTabBar({ items, onMore, moreLabel = 'More', moreBadge = null }) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/80 bg-white/95 backdrop-blur-md lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-2">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative flex min-w-14 flex-1 flex-col items-center gap-0.5 px-1.5 py-2 text-[11px] font-medium transition-colors ${
                  isActive ? 'text-primary-600' : 'text-slate-500 hover:text-slate-700'
                }`
              }
            >
              <Icon className="size-5" />
              <span className="max-w-full truncate">{item.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          onClick={onMore}
          aria-label={`Open full navigation menu (${moreLabel})`}
          className="relative flex min-w-14 flex-1 flex-col items-center gap-0.5 px-1.5 py-2 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-700"
        >
          <span className="relative">
            <IconMenu className="size-5" />
            {moreBadge ? (
              <span className="absolute -right-1.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary-600 px-1 text-[9px] font-bold leading-none text-white">
                {moreBadge > 9 ? '9+' : moreBadge}
              </span>
            ) : null}
          </span>
          <span className="max-w-full truncate">{moreLabel}</span>
        </button>
      </div>
    </nav>
  );
}
