import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { IconInbox, IconArrowRight } from '../../components/icons.jsx';

/** Student-scoped 404 — unknown /student/* paths land inside the student shell. */
export default function StudentNotFound() {
  return (
    <div className="mx-auto max-w-xl pt-8">
      <EmptyState
        icon={<IconInbox className="size-10" />}
        title="Page not found"
        description="That student page doesn't exist. Use the navigation to get back to your portal."
        action={
          <Link to="/student">
            <Button variant="secondary" icon={IconArrowRight}>Back to dashboard</Button>
          </Link>
        }
      />
    </div>
  );
}
