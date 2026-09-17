/**
 * Small persisted preferences (localStorage). These are the user's defaults —
 * the workspace to reopen and the model to start new sessions with — not
 * session state, which pi persists itself.
 */

export interface Prefs {
  /** workspace to reopen on boot */
  cwd?: string;
  /** provider/model to start new sessions with */
  provider?: string;
  modelId?: string;
  /** workspaces the user pinned to the switcher list */
  workspaces?: string[];
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
    for (const key of ['cwd', 'provider', 'modelId'] as const) {
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
