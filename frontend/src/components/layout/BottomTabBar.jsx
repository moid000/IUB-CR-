import { NavLink } from 'react-router-dom';
import { IconMenu } from '../icons.jsx';

/**
 * Mobile-only bottom tab bar (hidden from lg up, where the sidebar rail lives).
 * Gives the 4 most-used pages full-width thumb-reach navigation — each tab
 * shows its full label (the header hamburger opens the same Motion drawer the
 * old "More" button did). Professional app pattern (WhatsApp/Instagram).
 *
 * Props:
 *  - items: [{ to, label, icon, end?, badge? }] — badge shows the per-tab
 *    unread count (e.g. '1' on Assignments when a new assignment is unseen);
 *  - onMore/moreLabel/moreBadge: OPTIONAL legacy "More" button — render only
 *    when onMore is passed (currently unused by all shells)
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
              <span className="relative">
                <Icon className="size-5" />
                {item.badge ? (
                  <span className="absolute -right-1.5 -top-0.5 grid min-w-3.5 place-items-center rounded-full bg-primary-600 px-1 text-[9px] font-bold leading-none text-white">
                    {item.badge > 9 ? '9+' : item.badge}
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{item.label}</span>
            </NavLink>
          );
        })}
        {onMore ? (
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
        ) : null}
      </div>
    </nav>
  );
}
