/**
 * Parent-side driver for the Win32 folder dialog: spawns the dialog child
 * process (which blocks inside the modal `Show`), maps its message protocol
 * onto a promise, and services aborts by posting `WM_CLOSE` to the dialog
 * thread's windows until the child reports back. The real process/window
 * surface is injectable so every path is testable on any platform.
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { closeThreadWindows as postThreadWindows, importKoffi } from './win32-bindings';
import { DIALOG_TITLE } from './win32-dialog';
import type { Win32WorkerMessage, Win32WorkerPayload } from './win32-worker';

/** The child-process surface the driver drives (satisfied by `node:child_process`). */
export interface Win32WorkerLike {
  /**
   * Subscribe to a child-process event.
   * @param event - `message`, `error`, or `exit`.
   * @param listener - the event consumer.
   */
  on(event: 'message', listener: (message: Win32WorkerMessage) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  /** Force-stop the child; the abort path's last resort when `WM_CLOSE` never lands. */
  kill(): boolean;
  /**
   * Release the event-loop reference. Called once the pick settles so a child
   * stuck in the native modal call never blocks process exit.
   */
  unref?(): void;
}

/** What a pending pick needs from its caller. */
export interface Win32PickOptions {
  /** Directory the dialog opens in; null lets the shell decide. */
  initial?: string | null | undefined;
  /** Caller lifetime: aborting closes the dialog. Absent means never aborted. */
  signal?: AbortSignal | undefined;
}

/** Injectable process surface for deterministic driver tests. */
export interface Win32DialogInternals {
  /** Replaces the real child spawn (see {@link spawnDialogWorker}). */
  spawnWorker?: (payload: Win32WorkerPayload) => Win32WorkerLike;
  /** Replaces the real `WM_CLOSE` poster. */
  closeThreadWindows?: (threadId: number) => Promise<void>;
  /** Close-retry cadence override so tests never wait wall-clock time. */
  closeRetryMs?: number;
}

/** `WM_CLOSE` re-post cadence while an abort waits for the child to unwind. */
const CLOSE_RETRY_MS = 150;
/** Abort-service attempts before force-terminating the child. */
const CLOSE_MAX_ATTEMPTS = 20;

/** Whether the caller went away — its own helper so control flow cannot narrow the signal. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted === true;
}

/**
 * Spawn the dialog child process. The host runs from TypeScript (tsx in both
 * dev and `npm start`), so the child boots the same loader for its own entry.
 * @param payload - the child's dialog title and starting directory.
 * @returns the spawned child process.
 */
export function spawnDialogWorker(payload: Win32WorkerPayload): ChildProcess {
  const require = createRequire(import.meta.url);
  const env = {
    ...process.env,
    PI_WEBX_DIALOG_TITLE: payload.title,
    PI_WEBX_DIALOG_INITIAL: payload.initial ?? '',
  };
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc'];
  const loader = require.resolve('tsx/esm');
  const entry = fileURLToPath(new URL('./win32-worker.ts', import.meta.url));
  return spawn(process.execPath, ['--import', loader, entry], { env, stdio, windowsHide: true });
}

/** Post `WM_CLOSE` to a dialog thread's windows, loading koffi only now. */
async function closeDialogWindows(threadId: number): Promise<void> {
  await postThreadWindows(await importKoffi(), threadId);
}

/**
 * Open the modern Win32 folder picker off the event loop.
 * @param options - starting directory and the caller's lifetime signal.
 * @param internals - child-process and window hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickWin32Directory(
  options: Win32PickOptions,
  internals: Win32DialogInternals = {},
): Promise<string | null> {
  const signal = options.signal ?? new AbortController().signal;
  if (isAborted(signal)) throw new Error('native directory picker aborted');
  const spawnWorker = internals.spawnWorker ?? spawnDialogWorker;
  const closeWindows = internals.closeThreadWindows ?? closeDialogWindows;
  const closeRetryMs = internals.closeRetryMs ?? CLOSE_RETRY_MS;

  const worker: Win32WorkerLike = spawnWorker({ title: DIALOG_TITLE, initial: options.initial ?? null });
  let dialogThreadId: number | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let settled = false;

  return await new Promise<string | null>((resolve, reject) => {
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      if (closeTimer !== undefined) clearInterval(closeTimer);
      signal.removeEventListener('abort', onAbort);
      worker.unref?.();
      outcome();
    };

    const postClose = (): void => {
      // Before `showing` there is no window to close; the budget below still
      // runs so a child that never reports cannot dangle the pick. A rejected
      // close attempt (EnumThreadWindows/PostMessageW refusing) is discarded:
      // the interval retries it and kill is the backstop.
      if (dialogThreadId !== undefined) void closeWindows(dialogThreadId).catch(() => undefined);
    };

    const serviceAbort = (): void => {
      let attempts = 0;
      // The `showing` notice precedes the blocking `Show`, so the very first
      // WM_CLOSE can race the window's creation; re-post until the child
      // reports back, then force-kill as a last resort. The budget is
      // unconditional — an abort before `showing` (child hung in koffi or COM
      // init) still ends in kill instead of a dangling promise.
      closeTimer = setInterval(() => {
        attempts += 1;
        if (attempts > CLOSE_MAX_ATTEMPTS) {
          settle(() => {
            worker.kill();
            reject(new Error('native directory picker aborted (dialog unresponsive; child killed)'));
          });
          return;
        }
        postClose();
      }, closeRetryMs);
      postClose();
    };

    const onAbort = (): void => {
      serviceAbort();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: Win32WorkerMessage) => {
      switch (message.kind) {
        case 'showing':
          dialogThreadId = message.threadId;
          // An abort that raced ahead of this notice now has a window to hit.
          if (isAborted(signal)) postClose();
          return;
        case 'done':
          settle(() => {
            if (isAborted(signal)) reject(new Error('native directory picker aborted'));
            else resolve(message.path);
          });
          return;
        case 'error':
          settle(() => {
            reject(new Error(`win32 folder dialog failed: ${message.message}`));
          });
          return;
      }
    });
    worker.on('error', (error: Error) => {
      settle(() => {
        reject(error);
      });
    });
    worker.on('exit', () => {
      settle(() => {
        reject(new Error('win32 folder dialog child exited before reporting a result'));
      });
    });
  });
}
