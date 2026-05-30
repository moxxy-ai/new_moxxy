/**
 * Focus widget — dedicated entry point.
 *
 * The focus mode lives in its own BrowserWindow that loads focus.html,
 * a separate document with no splash fallback, no ClerkProvider, and
 * no main App. This means:
 *
 *   - No shared module side-effects from the main bundle (e.g. main.tsx
 *     wiring App + Clerk + StrictMode + a splash fallback that bled
 *     around the dot).
 *   - No #focus-hash detection — the URL is its own entry.
 *   - The focus renderer can fail catastrophically without affecting
 *     the main app and vice-versa.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { FocusWidget } from './FocusWidget';

const root = document.getElementById('root');
if (!root) {
  // Surface this in dev tools — without #root there's literally
  // nothing we can do.
  // eslint-disable-next-line no-console
  console.error('[focus] #root missing from focus.html');
} else {
  ReactDOM.createRoot(root).render(<FocusWidget />);
  // eslint-disable-next-line no-console
  console.log('[focus] mounted');
}
