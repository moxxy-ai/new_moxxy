/**
 * Shim for Next.js router exports that @clerk/elements optionally
 * imports. We're a plain Vite + React + Electron app, so no-op
 * stubs satisfy the imports without dragging Next in. Clerk's
 * virtual-router fallback handles routing for us.
 */
export function useRouter(): null {
  return null;
}

export function usePathname(): string {
  return '/';
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

export function useParams(): Record<string, string> {
  return {};
}

export function useSelectedLayoutSegment(): null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}

export function redirect(): never {
  throw new Error('redirect() called in non-Next environment');
}

export function notFound(): never {
  throw new Error('notFound() called in non-Next environment');
}
