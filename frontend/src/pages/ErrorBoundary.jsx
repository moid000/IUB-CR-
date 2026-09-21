import { Component, useState } from 'react';
import { useLocation } from 'react-router-dom';
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
  componentDidCatch(error, info) {
    // Surface in the browser console for debugging; never shown to users.
    console.error('[Tri3M] render error:', error, info?.componentStack);
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

/**
 * Per-PAGE error boundary. Wraps every route's page component so a crash in
 * one page (bad data, render bug) shows a friendly in-shell card instead of
 * taking down the whole portal — the nav/layout keep working, other pages stay
 * usable. "Try again" remounts the page; navigating away and back resets it too.
 */
export class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    console.error('[Tri3M] page render error:', error, info?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="grid place-items-center px-4 py-16">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200/80 bg-white p-8 text-center shadow-soft">
            <div className="mx-auto grid size-11 place-items-center rounded-full bg-amber-50">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="size-6 text-amber-600" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
              </svg>
            </div>
            <h2 className="mt-3 text-base font-semibold text-slate-900">This page couldn't load</h2>
            <p className="mt-1 text-sm text-slate-500">
              Something went wrong while loading this page. The rest of the app still works — try again, or check back in a few minutes.
            </p>
            <Button onClick={this.props.onRetry} className="mt-5 w-full" size="lg">
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Router-aware wrapper: resets the boundary on navigation and on retry. */
export function RouteErrorBoundary({ children }) {
  const { pathname } = useLocation();
  const [nonce, setNonce] = useState(0);
  return (
    <PageErrorBoundary key={`${pathname}:${nonce}`} onRetry={() => setNonce((n) => n + 1)}>
      {children}
    </PageErrorBoundary>
  );
}
