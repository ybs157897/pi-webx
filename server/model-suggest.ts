/**
 * "Smart configuration" for a model id: look it up in pi's own bundled model
 * catalogue and answer the fields pi would run it with.
 *
 * This is the pi-webx equivalent of the reference's model rules — ZCode fills
 * context window, output limit, input kinds and reasoning support from its
 * built-in model bank keyed by id; pi ships the same kind of bank inside
 * `@earendil-works/pi-ai` (`dist/providers/data/*.json`, one file per API
 * family). Reading it directly keeps the suggestion exactly what pi knows: no
 * second catalogue to drift.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { ModelSuggestMatch, ModelSuggestResponse } from '../src/shared/models-config';

/** id (lowercased) → the catalogue entry, built once and reused. */
let index: Map<string, ModelSuggestMatch> | null = null;

function catalogDir(): string | null {
  try {
    // The package's export map has no CJS main, so `require.resolve` cannot
    // reach it; ESM resolution honours the exports map and lands on dist/.
    const entry = import.meta.resolve('@earendil-works/pi-ai');
    const file = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
    return path.join(path.dirname(file), 'providers', 'data');
  } catch {
    return null;
  }
}

function toMatch(value: Record<string, unknown>): ModelSuggestMatch | null {
  const id = typeof value['id'] === 'string' ? value['id'] : undefined;
  if (id === undefined) return null;
  return {
    provider: typeof value['provider'] === 'string' ? value['provider'] : '',
    id,
    ...(typeof value['name'] === 'string' ? { name: value['name'] } : {}),
    ...(value['reasoning'] === true ? { reasoning: true } : {}),
    ...(Array.isArray(value['input'])
      ? { input: (value['input'] as unknown[]).filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(typeof value['contextWindow'] === 'number'
      ? { contextWindow: value['contextWindow'] as number }
      : {}),
    ...(typeof value['maxTokens'] === 'number' ? { maxTokens: value['maxTokens'] as number } : {}),
  };
}

/**
 * Harvest every model object out of one file. The layout is
 * `{ apiFamily: { modelId: Model } }`, but rather than pinning that shape the
 * walker descends plain objects and picks anything carrying a string `id` —
 * a layout change upstream then degrades to "no suggestion", never to a wrong
 * one.
 */
function harvest(node: unknown, out: Map<string, ModelSuggestMatch>): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  const match = toMatch(record);
  if (match !== null) {
    const key = match.id.toLowerCase();
    if (!out.has(key)) out.set(key, match);
    return;
  }
  for (const value of Object.values(record)) harvest(value, out);
}

function buildIndex(): Map<string, ModelSuggestMatch> {
  const out = new Map<string, ModelSuggestMatch>();
  const dir = catalogDir();
  if (dir === null) return out;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      harvest(JSON.parse(readFileSync(path.join(dir, file), 'utf8')), out);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Suggest the fields pi knows for `modelId`, or `null` when its catalogue does
 * not list the id (a private deployment's model, typically).
 */
export function suggestModelFields(modelId: string): ModelSuggestResponse {
  const wanted = modelId.trim().toLowerCase();
  if (wanted.length === 0) return { match: null };
  index ??= buildIndex();
  return { match: index.get(wanted) ?? null };
}
