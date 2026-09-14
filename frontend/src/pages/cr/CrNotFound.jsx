import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { IconInbox, IconArrowRight } from '../../components/icons.jsx';

/** CR-scoped 404 — unknown /cr/* paths land inside the CR shell. */
export default function CrNotFound() {
  return (
    <div className="mx-auto max-w-xl pt-8">
      <EmptyState
        icon={<IconInbox className="size-10" />}
        title="Page not found"
        description="That CR page doesn't exist. Use the navigation to get back to your section workspace."
        action={
          <Link to="/cr">
            <Button variant="secondary" icon={IconArrowRight}>Back to dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}
