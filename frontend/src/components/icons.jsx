/**
 * Minimal inline icon set (lucide-style, 24×24 stroke paths).
 * Small and quiet — 16px-20px usage, never giant.
 */
const I = ({ d, className = 'size-4', fill = 'none', viewBox = '0 0 24 24', strokeWidth = 2, ...rest }) => (
  <svg className={className} viewBox={viewBox} fill={fill} stroke={fill === 'none' ? 'currentColor' : 'none'} strokeWidth={strokeWidth} aria-hidden="true" {...rest}>
    {d}
  </svg>
);

export const IconGrid = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 6A2.25 2.25 0 0 1 15.75 3.75H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" /></>} />;
export const IconBuilding = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21" /></>} />;
export const IconCalendar = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></>} />;
export const IconLayers = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12 3 9.75 12 4.5l9 5.25-9 5.25-9-5.25Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M3 14.25 12 19.5l9-5.25" /></>} />;
export const IconUserSquare = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M15 9h3.75A.75.75 0 0 1 19.5 9.75v9a.75.75 0 0 1-.75.75h-13.5a.75.75 0 0 1-.75-.75v-9A.75.75 0 0 1 5.25 9H9m0-3.75a3 3 0 1 1 6 0V9m-6 0v9.75h6V9m-6 0h6" /></>} />;
export const IconGraduation = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.26 2.4 9.15a.75.75 0 0 1 0-1.3l9-5.2a1.5 1.5 0 0 1 1.5 0l9 5.2a.75.75 0 0 1 0 1.3l-9 5.2a1.5 1.5 0 0 1-1.5 0l-9-5.2Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M8.4 12.3v4.95c0 1.24 1.61 2.25 3.6 2.25s3.6-1.01 3.6-2.25V12.3" /></>} />;
export const IconBook = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></>} />;
export const IconSearch = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></>} />;
export const IconPlus = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />} />;
export const IconPencil = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.078a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></>} />;
export const IconArchive = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4m-9.75-6.375c.41-.135.847-.195 1.28-.195h13.94c.433 0 .87.06 1.28.195M3 7.5h18" /></>} />;
export const IconChevronLeft = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />} />;
export const IconChevronRight = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />} />;
export const IconChevronsLeft = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="m11.25 9-3 3 3 3M18.75 9l-3 3 3 3" /></>} />;
export const IconMenu = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />} />;
export const IconX = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />} />;
export const IconLogout = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" /></>} />;
export const IconCheck = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />} />;
export const IconAlert = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-1.5a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></>} />;
export const IconInfo = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.264-2.194a4.5 4.5 0 1 1 3.08 5.51L12 15l-.75-3.75ZM12 12h.008v.008H12V12Z" /><circle cx="12" cy="12" r="9" /></>} />;
export const IconUserPlus = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.204-3.203A4.5 4.5 0 0 1 12 15.75a4.5 4.5 0 0 1-2.204-8.017M6.75 21h10.5a2.25 2.25 0 0 0 2.25-2.25v-1.5a4.5 4.5 0 0 0-4.5-4.5h-6a4.5 4.5 0 0 0-4.5 4.5v1.5A2.25 2.25 0 0 0 6.75 21Z" /></>} />;
export const IconSwap = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></>} />;
export const IconUserMinus = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M22 10.5h-6m4.5-2.879a4.5 4.5 0 0 1-2.204 8.426M6.75 21h10.5a2.25 2.25 0 0 0 2.25-2.25v-1.5a4.5 4.5 0 0 0-4.5-4.5h-6a4.5 4.5 0 0 0-4.5 4.5v1.5A2.25 2.25 0 0 0 6.75 21ZM9 7.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" /></>} />;
export const IconClock = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></>} />;
export const IconInbox = (p) => <I {...p} d={<><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 13.5h3.75a3 3 0 0 1 3 3V18a3 3 0 0 0 3 3h1.5a3 3 0 0 0 3-3v-1.5a3 3 0 0 1 3-3h3.75M2.25 13.5V6A2.25 2.25 0 0 1 4.5 3.75h15A2.25 2.25 0 0 1 21.75 6v7.5M2.25 13.5 4.013 20.4a2.25 2.25 0 0 0 2.186 1.61h11.602a2.25 2.25 0 0 0 2.186-1.61l1.763-6.9" /></>} />;
export const IconArrowRight = (p) => <I {...p} d={<path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />} />;
