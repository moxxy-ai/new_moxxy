import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
import { FocusWidget } from './focus/FocusWidget';
import './styles.css';
import './focus/focus.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found — check index.html');

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// The focus-mode floating window loads the same bundle with #focus
// in the URL hash (or ?focus=1 query — Vite sometimes strips hashes
// during HMR negotiation, so we accept both).
const isFocus =
  typeof window !== 'undefined' &&
  (window.location.hash.includes('focus') ||
    window.location.search.includes('focus'));

// Tag the *root html element* (not body) so the focus-only CSS
// rules can size html itself to 100% — without this, body's
// height:100% computes against the default html height (which is
// auto / content-derived), collapsing the renderer to 0×0.
if (typeof document !== 'undefined' && isFocus) {
  document.documentElement.dataset['mode'] = 'focus';
  // Mirror onto body for any legacy selector that still expects it.
  document.body.dataset['mode'] = 'focus';
  // eslint-disable-next-line no-console
  console.log('[moxxy] focus mode renderer booted');
}

const Tree = isFocus ? (
  <FocusWidget />
) : CLERK_KEY ? (
  <ClerkProvider publishableKey={CLERK_KEY}>
    <App />
  </ClerkProvider>
) : (
  <App />
);

ReactDOM.createRoot(root).render(
  <React.StrictMode>{Tree}</React.StrictMode>,
);
