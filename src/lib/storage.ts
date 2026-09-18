/**
 * Small persisted preferences (localStorage). These are browser-local UI
 * preferences only — the workspace to reopen and the pinned workspace list.
 *
 * The model default deliberately does not live here. It is pi's own
 * `settings.json` value (`SettingsManager.setDefaultModelAndProvider`), written
 * by the picker, so the CLI and this UI cannot disagree about it — the same
 * reason dsh keeps its default in the settings layer rather than in client
 * storage. An earlier `provider`/`modelId` pair in this file was never written
 * by anything, which made it a silent second source of truth.
 */

export interface Prefs {
  /** workspace to reopen on boot */
  cwd?: string;
  /** workspaces the user pinned to the switcher list */
  workspaces?: string[];
  /**
   * Workspaces the user removed from the list (`从列表移除`).
   *
   * The sidebar's workspace list is *derived* — the current cwd, the server's
   * suggestions, and every cwd that has a session — so dropping a path from
   * `workspaces` is not enough to remove its row: the derivation puts it
   * straight back. A removal therefore has to be remembered as a hidden path,
   * which the derivation subtracts. Non-destructive: nothing on disk is
   * touched, and picking the path again clears the entry.
   */
  hiddenWorkspaces?: string[];
}

const KEY = 'pi-webx-prefs';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const prefs: Prefs = {};
    for (const key of ['cwd'] as const) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) prefs[key] = value;
    }
    const workspaces = parsed['workspaces'];
    if (Array.isArray(workspaces)) {
      const paths = workspaces.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      );
      if (paths.length > 0) prefs['workspaces'] = paths.slice(0, 20);
    }
    const hidden = parsed['hiddenWorkspaces'];
    if (Array.isArray(hidden)) {
      const paths = [...new Set(hidden.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      ))];
      if (paths.length > 0) prefs['hiddenWorkspaces'] = paths.slice(0, 100);
    }
    return prefs;
  } catch {
    return {};
  }
}

export function savePrefs(patch: Partial<Prefs>): void {
  const next = { ...loadPrefs(), ...patch };
  for (const key of Object.keys(next) as (keyof Prefs)[]) {
    const value = next[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); prefs are best-effort.
  }
}
