/**
 * Total accessors for the unknown JSON that arrives on pi's event stream.
 *
 * Part of the transcript reducer; `./index.ts` is the only public entry point,
 * so nothing here is exported to consumers.
 */

/* ------------------------------------------------------------------ parsing */
/*
 * Events and messages arrive as JSON. The wire types describe what pi *should*
 * send, but a reducer that throws on a missing field is worse than one that
 * degrades, so every read goes through a total accessor.
 */

export type Dict = Record<string, unknown>;

export function asRecord(value: unknown): Dict | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Dict;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function timestampOf(message: unknown, fallback: number): number {
  return asNumber(asRecord(message)?.timestamp) ?? fallback;
}
