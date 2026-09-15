import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Avatar } from '../files/Avatar.jsx';
import { Badge } from '../ui/Badge.jsx';

const EASE = [0.22, 1, 0.36, 1];

/**
 * Unified account dropdown for all three portal headers.
 * One visual language: identity block (name/email/role chip) then actions.
 * `menuItems` = [{ to | onClick, label, icon, danger }].
 */
export function AccountMenu({ user, roleLabel, roleVariant = 'primary', menuItems = [] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1.5 pl-1.5 pr-2 text-left shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-slate-300 hover:shadow-lift active:translate-y-0 sm:pr-3"
      >
        <Avatar user={user} size={7} />
        <span className="hidden max-w-[140px] sm:block">
          <span className="block truncate text-xs font-semibold text-slate-800">{user?.name ?? 'Account'}</span>
          <span className="block truncate text-[11px] text-slate-500">{roleLabel}</span>
        </span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu" aria-label="Account menu"
            className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.99 }}
            transition={{ duration: 0.16, ease: EASE }}
          >
            <div className="border-b border-slate-100 px-4 py-3.5">
              <p className="truncate text-sm font-semibold text-slate-900">{user?.name ?? 'Account'}</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">{user?.email}</p>
              <Badge variant={roleVariant} className="mt-2">{roleLabel}</Badge>
            </div>
            <div className="p-1.5">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const cls = `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors
                  ${item.danger ? 'text-red-600 hover:bg-red-50' : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900'}`;
                return item.to ? (
                  <NavLink key={item.label} to={item.to} onClick={() => setOpen(false)} className={cls} role="menuitem">
                    {Icon && <Icon className="size-4" />} {item.label}
                  </NavLink>
                ) : (
                  <button key={item.label} type="button" role="menuitem" onClick={() => { setOpen(false); item.onClick?.(); }} className={cls}>
                    {Icon && <Icon className="size-4" />} {item.label}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

