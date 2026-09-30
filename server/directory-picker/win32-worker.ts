/**
 * Child-process entry for the Win32 folder dialog: blocks THIS process inside
 * the modal `Show` so the host event loop stays live, reporting over the IPC
 * channel. Spawned as a child process (not a worker thread) so a native fault
 * stays contained and the modal call never wedges the host. A background host
 * (the web GUI server) leaves this process without foreground rights, so
 * `runFolderDialog` synthesizes an Alt press immediately before `Show` and the
 * dialog then activates as foreground.
 *
 * Protocol: `{kind:'showing', threadId}` right before the blocking call (the
 * driver's abort lever needs the native thread id), then exactly one of
 * `{kind:'done', path}` or `{kind:'error', message}`.
 */

import { importKoffi, loadWin32DialogBindings } from './win32-bindings';
import { runFolderDialog } from './win32-dialog';

/** The driver-to-child payload, carried in the environment. */
export interface Win32WorkerPayload {
  /** Dialog title text. */
  title: string;
  /** Directory the dialog opens in; null lets the shell decide. */
  initial: string | null;
}

/** One notice or outcome posted back to the driver. */
export type Win32WorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string };

const title = process.env['PI_WEBX_DIALOG_TITLE'] ?? '';
const initial = process.env['PI_WEBX_DIALOG_INITIAL'] ?? '';
if (process.send === undefined) throw new Error('win32 dialog worker must run as a child process with an IPC channel');

// node's internal `send` reads `this.connected`, so bind the receiver.
const send = process.send.bind(process);
const post = (message: Win32WorkerMessage): void => {
  // Flush before closing the channel; the process exits when the loop drains.
  send(message, () => { if (process.connected) process.disconnect(); });
};

// A settled driver (or a dead parent) must not orphan a dialog still on screen.
process.on('disconnect', () => process.exit(0));

// No top-level await: the child is launched through tsx's ESM loader, which
// keeps supporting it either way.
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings(await importKoffi());
    const path = runFolderDialog(bindings, title, initial === '' ? null : initial, (threadId) => {
      post({ kind: 'showing', threadId } satisfies Win32WorkerMessage);
    });
    post({ kind: 'done', path } satisfies Win32WorkerMessage);
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    post({ kind: 'error', message } satisfies Win32WorkerMessage);
  }
})();
