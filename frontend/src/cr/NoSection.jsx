import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/EmptyState.jsx';
import { IconLayers } from '../components/icons.jsx';

/**
 * Professional "no section assigned" state. The section is ALWAYS
 * server-derived — the frontend never lets a CR pick one.
 */
export function NoSection() {
  return (
    <EmptyState
      icon={<IconLayers className="size-10" />}
      title="No section assigned"
      description="You haven't been assigned to a section yet. An administrator assigns CRs to sections — once that happens, everything here unlocks automatically."
      action={
        <Link
          to="/cr/profile"
          className="inline-flex h-10 items-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
        >
          View your profile
        </Link>
      }
    />
  );
}
