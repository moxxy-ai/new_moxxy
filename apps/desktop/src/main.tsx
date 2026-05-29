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
// in the URL hash — mount the compact widget instead of the full app
// so we don't pay for ClerkProvider, the sidebar tree, the chat
// transcript, etc. in a 380x200 surface.
const isFocus = typeof window !== 'undefined' && window.location.hash === '#focus';

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
