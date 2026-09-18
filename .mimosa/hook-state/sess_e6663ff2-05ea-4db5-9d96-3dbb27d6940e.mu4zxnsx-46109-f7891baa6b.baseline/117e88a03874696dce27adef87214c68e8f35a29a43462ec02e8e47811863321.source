/**
 * Model discovery for the config UI: asks a provider for its model list
 * (`GET <baseUrl>/models`, the OpenAI shape) so the editor can offer real ids
 * before anything is saved to `models.json`.
 *
 * Security posture (mirrors the bridge's "no arbitrary outbound requests"
 * rule): only public http/https endpoints are contacted. The host is checked
 * as a literal and again after DNS resolution, and loopback, private,
 * link-local, and reserved addresses are refused — the bridge must not become
 * a proxy that a page in the user's browser can aim at local services.
 *
 * Keys are literal or `$VAR`/`${VAR}` references, resolved from the editor
 * form or the provider's stored entry. No shell execution happens here: pi's
 * `!command` key form is intentionally NOT resolved (a provider whose stored
 * key is a shell form is probed without Authorization; paste the literal key
 * into the form to authenticate). A resolved key is only ever placed in the
 * Authorization header — never in logs, error text, or the response body.
 */

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';

import { readProviderCredentials } from './models-config';

/** Upper bound for the provider request. */
const REQUEST_TIMEOUT_MS = 10_000;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

export class ModelDiscoveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DiscoverModelsRequest {
  /** Explicit value from the editor form; wins over the stored provider. */
  baseUrl?: string;
  /** Fallback source for baseUrl and apiKey when the form leaves them blank. */
  providerId?: string;
  /** Raw form value for the key (literal / `$ENV`), may be blank. */
  apiKey?: string;
}

export async function discoverModels(request: DiscoverModelsRequest): Promise<string[]> {
  const provider = request.providerId ? readProviderCredentials(request.providerId) : undefined;

  const baseUrl = normalizeBaseUrl(request.baseUrl) ?? normalizeBaseUrl(provider?.baseUrl);
  if (!baseUrl) throw new ModelDiscoveryError(400, '缺少 Base URL');

  const apiKey = resolveCredential(request.apiKey) ?? resolveCredential(provider?.apiKey);

  const response = await fetchModels(baseUrl, apiKey);
  return parseModelIds(response);
}

/* ------------------------------------------------------------- resolution */

/**
 * Resolve a credential value: literal or `$VAR`/`${VAR}` (with `$$`/`$!`
 * escaping a literal `$`/`!`). Values that start with an unescaped `!` are
 * pi's shell-command form and are refused — this server never executes them.
 * Returns undefined when the reference cannot be resolved, which the caller
 * treats as "no credential" — never as an error carrying the value.
 */
export function resolveCredential(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.startsWith('!')) {
    throw new ModelDiscoveryError(400, '密钥的 !shell 形式不被支持：请直接粘贴密钥或使用 $ENV 引用');
  }
  return resolveTemplate(value);
}

function resolveTemplate(template: string): string | undefined {
  let resolved = '';
  let index = 0;

  while (index < template.length) {
    const dollar = template.indexOf('$', index);
    if (dollar < 0) {
      resolved += template.slice(index);
      break;
    }
    resolved += template.slice(index, dollar);

    const next = template.charAt(dollar + 1);
    if (next === '$' || next === '!') {
      resolved += next;
      index = dollar + 2;
      continue;
    }
    if (next === '{') {
      const end = template.indexOf('}', dollar + 2);
      if (end < 0) {
        resolved += '$';
        index = dollar + 1;
        continue;
      }
      const name = template.slice(dollar + 2, end);
      if (!ENV_NAME.test(name)) {
        resolved += template.slice(dollar, end + 1);
        index = end + 1;
        continue;
      }
      const fromEnv = process.env[name];
      if (fromEnv === undefined) return undefined;
      resolved += fromEnv;
      index = end + 1;
      continue;
    }

    const rest = template.slice(dollar + 1);
    const match = rest.match(ENV_NAME_PREFIX);
    const name = match === null ? '' : (match[0] ?? '');
    if (name.length > 0) {
      const fromEnv = process.env[name];
      if (fromEnv === undefined) return undefined;
      resolved += fromEnv;
      index = dollar + 1 + name.length;
      continue;
    }

    resolved += '$';
    index = dollar + 1;
  }

  return resolved.length > 0 ? resolved : undefined;
}

/* ------------------------------------------------------------- host policy */

/** Hostnames never worth a DNS lookup. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

function isBlockedIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // protocol assignments / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === '::' || addr === '::1') return true; // unspecified, loopback
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local
  if (addr.startsWith('fe8') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) {
    return true; // link-local
  }
  if (addr.startsWith('ff')) return true; // multicast
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped !== null) return isBlockedIPv4(mapped[1] ?? ''); // IPv4-mapped
  return false;
}

/** Whether a literal hostname (brackets stripped) must be refused outright. */
function isBlockedLiteralHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (isIPv4(host)) return isBlockedIPv4(host);
  if (isIPv6(host)) return isBlockedIPv6(host);
  return false;
}

/**
 * Refuse anything that is not a public http/https endpoint. Literal IPs are
 * checked directly; names are resolved and every address is checked, so a
 * hostname that only sometimes points inside is still refused.
 */
async function assertPublicEndpoint(rawUrl: string): Promise<URL> {
  const parsed = await assertPublicHttpUrl(rawUrl);

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isIPv4(hostname) && !isIPv6(hostname)) {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new ModelDiscoveryError(502, `域名无法解析：${hostname}`);
    }
    if (addresses.length === 0) {
      throw new ModelDiscoveryError(502, `域名没有解析结果：${hostname}`);
    }
    if (addresses.some((entry) => isBlockedLiteralHost(entry.address))) {
      throw new ModelDiscoveryError(400, `域名解析到了内网或保留地址，已拒绝：${hostname}`);
    }
  }
  return parsed;
}

/**
 * The entry-visible half of the host policy: protocol and literal-host checks
 * that a route can run synchronously on the raw body value before anything
 * flows further. DNS validation still runs at fetch time.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ModelDiscoveryError(400, `Base URL 不是合法 URL：${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelDiscoveryError(400, 'Base URL 只允许 http/https 协议');
  }
  if (isBlockedLiteralHost(parsed.hostname.replace(/^\[|\]$/g, ''))) {
    throw new ModelDiscoveryError(400, '拉取模型列表仅允许公网地址：内网、环回与保留地址已被拒绝');
  }
  return parsed;
}

/* ---------------------------------------------------------------- request */

function normalizeBaseUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return value.replace(/\/+$/, '');
}

async function fetchModels(baseUrl: string, apiKey: string | undefined): Promise<Response> {
  // The host policy runs inside the request path so DNS is checked right
  // before the fetch, not only when the URL was first parsed.
  const parsed = await assertPublicEndpoint(`${baseUrl}/models`);
  const target = `${parsed.origin}${parsed.pathname}${parsed.search}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey !== undefined) headers['authorization'] = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new ModelDiscoveryError(
        502,
        `拉取模型列表失败：请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`,
      );
    }
    throw new ModelDiscoveryError(502, `拉取模型列表失败：${networkSummary(error)}`);
  }

  if (!response.ok) {
    const statusText = response.statusText.trim();
    const status = statusText.length > 0 ? `${response.status} ${statusText}` : String(response.status);
    throw new ModelDiscoveryError(502, `拉取模型列表失败：${status}`);
  }
  return response;
}

/** `fetch` hides the real reason in `cause`; surface it without the request. */
function networkSummary(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message.length > 0) return cause.message;
    if (error.message.length > 0) return error.message;
  }
  return String(error);
}

/* ------------------------------------------------------------------ parse */

async function parseModelIds(response: Response): Promise<string[]> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelDiscoveryError(502, '拉取模型列表失败：响应不是合法 JSON');
  }

  const items = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload['data'])
      ? (payload['data'] as unknown[])
      : null;
  if (!items) {
    throw new ModelDiscoveryError(502, '拉取模型列表失败：响应缺少 data 数组');
  }

  const ids = new Set<string>();
  for (const item of items) {
    const candidate =
      typeof item === 'string' ? item : isRecord(item) && typeof item['id'] === 'string' ? item['id'] : '';
    const id = candidate.trim();
    if (id.length > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
