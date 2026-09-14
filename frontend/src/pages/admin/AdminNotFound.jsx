import { Link } from 'react-router-dom';
import { PageContainer } from '../../components/ui/PageContainer.jsx';
import { Button } from '../../components/ui/Button.jsx';
import { EmptyState } from '../../components/ui/EmptyState.jsx';
import { IconGrid } from '../../components/icons.jsx';

/** Clean admin 404 — unknown /admin/* routes never break the SPA. */
export default function AdminNotFound() {
  return (
    <PageContainer>
      <div className="py-20">
        <EmptyState
          icon={<IconGrid className="size-10" />}
          title="Page not found"
          description="This admin page doesn't exist. It may have been moved or the link is wrong."
          action={<Link to="/admin"><Button>Back to overview</Button></Link>}
        />
      </div>
    </PageContainer>
  );
}
