/**
 * Native single-directory chooser: the OS owns the dialog, so the user gets
 * their own sidebar, favourites, and network locations instead of a hand-rolled
 * tree listing.
 *
 * Ported from deepseek-harness's `host/directory-picker-native`, minus its Win32
 * koffi binding: darwin drives AppleScript's `choose folder`, linux falls back
 * zenity → kdialog, and any other platform reports that it has no picker rather
 * than pretending it has one. Nothing goes through a shell — `execFile` passes
 * argv directly, so a directory whose name contains a quote, a space, or a `$`
 * stays a string and never becomes a command.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

/** Dialog prompt, kept identical to dsh's so both apps read the same way. */
const PROMPT = 'Select Workspace Directory';

/** This host has no native picker at all — which is not the same as a cancel. */
export class DirectoryPickerUnsupportedError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`no native directory picker on ${platform}`);
    this.name = 'DirectoryPickerUnsupportedError';
  }
}

export interface PickNativeDirectoryOptions {
  /** Directory the dialog opens in; ignored when it does not exist. */
  initial?: string | undefined;
  /** Request lifetime: aborting kills the dialog process. */
  signal?: AbortSignal | undefined;
}

/**
 * Open the platform directory picker.
 * @param options - Starting directory and the caller's lifetime signal.
 * @returns the chosen absolute path, or null when the user dismissed the dialog.
 * @throws {DirectoryPickerUnsupportedError} when the platform has no picker.
 */
export async function pickNativeDirectory(
  options: PickNativeDirectoryOptions = {},
): Promise<string | null> {
  const initial = existingDirectory(options.initial);
  const platform = process.platform;
  if (platform === 'darwin') return await pickWithAppleScript(initial, options.signal);
  if (platform === 'linux') return await pickWithLinux(initial, options.signal);
  throw new DirectoryPickerUnsupportedError(platform);
}

/** A child failure carrying the exit code and stderr Node's callback reports. */
interface NativeFailure extends Error {
  code?: string | number | null;
  stderr?: string;
}

/** Run one native command and resolve its stdout, or reject with its failure. */
function runNative(
  command: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      const failure: NativeFailure = error;
      failure.stderr = stderr;
      reject(failure);
    });
  });
}

/** Trim the trailing newline a chooser prints; empty output means nothing chosen. */
function chosenPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '');
  return path === '' ? null : path;
}

function failureCode(error: unknown): string | number | null | undefined {
  return error instanceof Error && 'code' in error ? (error as NativeFailure).code : undefined;
}

function failureStderr(error: unknown): string {
  return error instanceof Error && 'stderr' in error ? (error as NativeFailure).stderr ?? '' : '';
}

/** osascript reports a dismissed dialog as a plain exit 1 on stderr. */
function isCancellation(error: unknown): boolean {
  return failureCode(error) === 1 && /User canceled|-128/i.test(failureStderr(error));
}

/** Whether the caller went away — its own helper so control flow cannot narrow the signal. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `undefined` unless the candidate is a directory this process can stat. */
function existingDirectory(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate.trim().length === 0) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/** AppleScript string literal: only the backslash and the double quote are special. */
function appleScriptLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function pickWithAppleScript(
  initial: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const prompt = appleScriptLiteral(PROMPT);
  const locate = initial === undefined
    ? `choose folder with prompt ${prompt}`
    : `choose folder with prompt ${prompt} default location POSIX file ${appleScriptLiteral(initial)}`;
  try {
    const stdout = await runNative(
      'osascript',
      ['-e', `set chosen to ${locate}`, '-e', 'POSIX path of chosen'],
      signal,
    );
    return chosenPath(stdout);
  } catch (error) {
    // An aborted request is not a user decision: let the caller see the abort.
    if (isAborted(signal)) throw error;
    if (isCancellation(error)) return null;
    throw new Error(`osascript could not open the picker: ${failureStderr(error).trim() || 'unknown error'}`);
  }
}

async function pickWithLinux(
  initial: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const zenityArgs = ['--file-selection', '--directory', `--title=${PROMPT}`];
  if (initial !== undefined) zenityArgs.push(`--filename=${initial}/`);
  try {
    return chosenPath(await runNative('zenity', zenityArgs, signal));
  } catch (error) {
    if (isAborted(signal)) throw error;
    // zenity exits 1 when dismissed; a missing binary is what selects kdialog.
    if (failureCode(error) === 1) return null;
    if (failureCode(error) !== 'ENOENT') {
      throw new Error(`zenity could not open the picker: ${failureStderr(error).trim() || 'unknown error'}`);
    }
  }

  const kdialogArgs = ['--getexistingdirectory', initial ?? '.', '--title', PROMPT];
  try {
    return chosenPath(await runNative('kdialog', kdialogArgs, signal));
  } catch (error) {
    if (isAborted(signal)) throw error;
    if (failureCode(error) === 1) return null;
    if (failureCode(error) === 'ENOENT') {
      throw new DirectoryPickerUnsupportedError(process.platform);
    }
    throw new Error(`kdialog could not open the picker: ${failureStderr(error).trim() || 'unknown error'}`);
  }
}
