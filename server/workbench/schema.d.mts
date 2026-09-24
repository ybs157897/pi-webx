export const ARRAY_MODULES: readonly ['tasks', 'works', 'hotspots', 'exercises', 'meals', 'finance', 'reviews', 'fixes', 'logs', 'requirements', 'codes', 'knowledge', 'knowledgeBases', 'knowledgeFolders'];
export const ATOM_MODULES: readonly ['pets', 'relationships'];
export const MODULE_LABELS: Record<string, string>;

export function emptyState(profile?: Record<string, unknown>): Record<string, unknown>;
export function demoState(now?: Date): Record<string, unknown>;
export function validateFields(module: string, fields: unknown, options?: { partial?: boolean }): Record<string, unknown>;
export function validateAtomProfile(module: string, fields: unknown, options?: { partial?: boolean }): Record<string, unknown>;
export function validateAtomRecord(fields: unknown, options?: { partial?: boolean }): Record<string, unknown>;
export function todayISO(now?: Date): string;
