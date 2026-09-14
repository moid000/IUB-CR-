import { Badge } from '../ui/Badge.jsx';
import { IconCheck, IconClock, IconArchive } from '../icons.jsx';

/**
 * Status communication — never color-only: text label + icon.
 */
export function StatusBadge({ status }) {
  if (status === 'active') {
    return <Badge variant="success"><IconCheck className="size-3" /><span className="sr-only">Status: </span>Active</Badge>;
  }
  if (status === 'archived') {
    return <Badge variant="neutral"><IconArchive className="size-3" /><span className="sr-only">Status: </span>Archived</Badge>;
  }
  return <Badge variant="neutral">{status}</Badge>;
}

export function RegistrationBadge({ status, emailVerified }) {
  const map = {
    pending: { variant: 'warning', label: 'Pending activation', icon: IconClock },
    active: { variant: 'success', label: 'Active', icon: IconCheck },
    suspended: { variant: 'danger', label: 'Suspended', icon: IconArchive },
  };
  const cfg = map[status] ?? { variant: 'neutral', label: status, icon: IconClock };
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant}>
      <Icon className="size-3" />
      {cfg.label}
      {status === 'active' && emailVerified === false && <span className="sr-only">(email not verified)</span>}
    </Badge>
  );
}
