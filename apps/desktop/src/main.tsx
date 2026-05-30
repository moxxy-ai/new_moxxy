import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found — check index.html');

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

const Tree = CLERK_KEY ? (
  <ClerkProvider publishableKey={CLERK_KEY}>
    <App />
  </ClerkProvider>
) : (
  <App />
);

// ErrorBoundary sits OUTSIDE ClerkProvider so it also catches a provider
// init throw (e.g. a malformed key). Without a boundary, any uncaught
// renderer error unmounts the whole React tree → a blank white window with
// nothing logged — which is exactly what a keyless build did (useUser threw
// because no <ClerkProvider> was rendered).
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>{Tree}</ErrorBoundary>
  </React.StrictMode>,
);
