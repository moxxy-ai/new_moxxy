import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { App } from './App';
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

ReactDOM.createRoot(root).render(<React.StrictMode>{Tree}</React.StrictMode>);
