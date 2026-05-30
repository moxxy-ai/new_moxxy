/**
 * Shared style tokens for the WorkspaceSidebar rail. Kept tiny and
 * dependency-free so the container and its sub-components share the same
 * list-reset look without re-declaring it.
 */

export const listReset: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};
