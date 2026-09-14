import { Component } from 'react';
import { Button } from '../components/ui/Button.jsx';

/** Render-time error boundary — friendly message, never internals. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // deliberately no-op: nothing technical is surfaced to the user
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="grid min-h-dvh place-items-center bg-slate-50 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200/70 bg-white/80 p-8 text-center shadow-soft">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p className="mt-1.5 text-sm text-slate-500">
              An unexpected error occurred. Please reload — if it keeps happening, come back in a few minutes.
            </p>
            <Button onClick={() => window.location.reload()} className="mt-6 w-full" size="lg">
              Reload page
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
