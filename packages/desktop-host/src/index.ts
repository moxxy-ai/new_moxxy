/**
 * Public surface of the desktop main-process host. The @moxxy/desktop
 * app's thin `electron/main/index.ts` entry wires these together; the
 * rest of the host (stores, the IPC handler bodies, the runner internals)
 * stays encapsulated behind this barrel.
 */

export { RunnerPool, UNBOUND_ID } from './runner-pool.js';
export { bindWindow, registerIpcHandlers } from './ipc.js';
export { preferredCliEntry } from './cli-resolver.js';
export { DeskStore } from './desks.js';
export { sweepStaleSockets } from './sweep-sockets.js';
export {
  bindMainWindowMinimize,
  closeFocusWindow,
  resizeFocusWindow,
  showFocusWindow,
  toggleFocusWindow,
  isFocusOpen,
} from './focus-window.js';
export {
  installContentSecurityPolicy,
  lockDownNavigation,
  isSafeExternalUrl,
} from './security.js';
