/**
 * Electron preload — runs with Node-like access AND in the renderer's
 * world. The only thing it ships to the renderer is `window.moxxy`,
 * built from the typed [`IpcCommands`] / [`IpcEvents`] contracts. The
 * renderer cannot reach the raw `ipcRenderer` (context isolation is
 * on), so this is the only path across the boundary.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcCommandName,
  IpcEvents,
  MoxxyApi,
} from '@moxxy/desktop-ipc-contract';

const api: MoxxyApi = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: ((command: IpcCommandName, ...args: any[]) =>
    ipcRenderer.invoke(command, ...args)) as MoxxyApi['invoke'],
  subscribe: <K extends keyof IpcEvents>(
    channel: K,
    handler: (payload: IpcEvents[K]) => void,
  ): (() => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, payload: IpcEvents[K]): void => {
      handler(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('moxxy', api);

// Augment the renderer-side global so consumers get types.
declare global {
  interface Window {
    moxxy: MoxxyApi;
  }
}
