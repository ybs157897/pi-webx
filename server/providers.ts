/**
 * Provider and credential surfaces for the settings page.
 *
 * Ported from deepseek-harness, which splits this into `llm.listProviders` /
 * `llm.listConfigurableProviders` (which providers exist, and which of them can
 * be configured) and a separate `credentials` capability (`describe` / `set` /
 * `unset`). Two of its rules carry over verbatim:
 *
 *   1. **Providers are listed by capability, never by id.** dsh only asks
 *      whether `auth.apiKey.login` / `auth.oauth` exist, with a comment saying
 *      "never assume it from an id". pi's provider records carry exactly that
 *      `auth` shape, so the list is derived rather than hard-coded and a
 *      provider added to pi appears here without a change in this file.
 *   2. **The credential view has no slot a value could ride in.** dsh's is
 *      `{configured, source, writable}` and it never returns a key or a masked
 *      tail; pi's `getProviderAuthStatus` and `CredentialInfo` are the same
 *      shape, and we pass them through rather than enriching them.
 *
 * Writes go through pi's own `ModelRuntime.login` / `logout`, which is the
 * counterpart of dsh calling the provider's own `auth.apiKey.login()` instead of
 * hand-building a request: the provider answers its own extra questions (an
 * account id, a gateway, a token kind) and pi-ai persists the result through
 * `CredentialStore.modify` — the store's only write path, which for pi is
 * AuthStorage's proper-lockfile-guarded `auth.json`. Because that lock is the
 * same one the CLI takes, a key written here is visible to `pi` immediately.
 *
 * `ModelRuntime.setRuntimeApiKey` is deliberately **not** used: it writes to
 * `RuntimeCredentials`, whose own contract calls it a "non-persistent runtime
 * API key" overlay, so the key would be lost on restart.
 */

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import type {
  ProviderAuthMethod,
  ProviderCredentialState,
  ProviderView,
  SetCredentialRequest,
} from '../src/shared/providers';

/** A credential operation the runtime refused; surfaced as a 4xx/5xx. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** pi's `apiKey`/`oauth` auth records, read without assuming a provider id. */
interface RawAuthMethod {
  name?: string;
  login?: unknown;
  loginLabel?: string;
  isSubscription?: boolean;
}

interface RawProviderAuth {
  apiKey?: RawAuthMethod;
  oauth?: RawAuthMethod;
}

function toMethod(raw: RawAuthMethod | undefined): ProviderAuthMethod | undefined {
  if (raw === undefined || raw === null) return undefined;
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined;
  return {
    // A method with no `login` is ambient-only (a key from the environment we
    // cannot write): listed, but not offered as an editable field.
    interactive: typeof raw.login === 'function',
    ...(name === undefined ? {} : { name }),
    ...(typeof raw.loginLabel === 'string' ? { loginLabel: raw.loginLabel } : {}),
    ...(raw.isSubscription === true ? { subscription: true } : {}),
  };
}

/**
 * Every provider the runtime knows, with its credential state.
 *
 * @param runtime - the shared model runtime.
 * @param declaredIds - provider ids that come from `models.json`, i.e. the ones
 *   the custom-provider editor owns. dsh draws the same line: a route the
 *   directory reports as declared exposes its own name and protocol, a catalog
 *   route does not.
 * @returns the list, routable providers first so the usable ones lead.
 */
export async function listProviders(
  runtime: ModelRuntime,
  declaredIds: readonly string[],
): Promise<ProviderView[]> {
  const declared = new Set(declaredIds);
  const credentials = await runtime.listCredentials().catch(() => [] as const);
  const storedByProvider = new Map<string, 'api_key' | 'oauth'>();
  for (const entry of credentials) {
    storedByProvider.set(entry.providerId, entry.type);
  }

  const views: ProviderView[] = [];
  for (const provider of runtime.getProviders()) {
    const providerId = provider.id;
    const auth = (provider.auth ?? {}) as RawProviderAuth;

    let status = { configured: false } as ProviderCredentialState;
    try {
      const raw = runtime.getProviderAuthStatus(providerId);
      if (raw !== undefined && raw !== null) {
        status = {
          configured: raw.configured === true,
          ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        };
      }
    } catch {
      // A provider whose status cannot be read is listed as unconfigured rather
      // than dropped: the row is where a user would fix it.
    }

    const stored = storedByProvider.get(providerId) ?? null;
    views.push({
      id: providerId,
      name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : providerId,
      methods: {
        ...(toMethod(auth.apiKey) === undefined ? {} : { apiKey: toMethod(auth.apiKey) }),
        ...(toMethod(auth.oauth) === undefined ? {} : { oauth: toMethod(auth.oauth) }),
      },
      status,
      storedCredential: stored,
      usingOAuth: safeBoolean(() => runtime.isUsingOAuth(providerId)),
      usingSubscription: safeBoolean(() => runtime.isUsingSubscription(providerId)),
      modelCount: safeModelCount(runtime, providerId),
      declared: declared.has(providerId),
    });
  }

  views.sort((left, right) => {
    const leftRank = left.status.configured ? 0 : 1;
    const rightRank = right.status.configured ? 0 : 1;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });
  return views;
}

function safeBoolean(read: () => boolean): boolean {
  try {
    return read() === true;
  } catch {
    return false;
  }
}

function safeModelCount(runtime: ModelRuntime, providerId: string): number {
  try {
    return runtime.getModels(providerId).length;
  } catch {
    return 0;
  }
}

/**
 * Scripted answerer for the provider's own login dialogue.
 *
 * The provider decides what to ask (`AuthPrompt`); we answer the two shapes that
 * carry a key and pick the API-key option when the provider offers a choice of
 * token kinds. Anything else is refused explicitly, so a provider whose flow we
 * cannot drive reports that instead of silently storing a wrong credential.
 */
function scriptedInteraction(apiKey: string, events: AuthEvent[]): AuthInteraction {
  return {
    notify(event: AuthEvent): void {
      events.push(event);
    },
    async prompt(prompt: AuthPrompt): Promise<string> {
      switch (prompt.type) {
        case 'secret':
        case 'text':
          return apiKey;
        case 'select': {
          // pi-web answers the same prompt the same way: prefer the api-key option,
          // then a bearer token, then whatever the provider listed first.
          const options = prompt.options ?? [];
          const preferred =
            options.find((option) => /api[-_ ]?key/i.test(option.id)) ??
            options.find((option) => /api[-_ ]?key/i.test(option.label)) ??
            options.find((option) => /bearer/i.test(`${option.id} ${option.label}`)) ??
            options[0];
          if (preferred === undefined) {
            throw new Error(`无法为「${prompt.message}」选择凭据类型：provider 没有给出选项`);
          }
          return preferred.id;
        }
        default:
          throw new Error(
            `该 provider 的录入流程需要人工输入（${prompt.type}: ${prompt.message}），当前界面暂不支持`,
          );
      }
    },
  };
}

/**
 * Store an API key for one provider through the provider's own login flow.
 *
 * @param runtime - the shared model runtime.
 * @param providerId - target provider.
 * @param body - the submitted key.
 * @returns the refreshed provider list, so the caller replaces its state.
 */
export async function setProviderCredential(
  runtime: ModelRuntime,
  providerId: string,
  body: SetCredentialRequest,
  declaredIds: readonly string[],
): Promise<ProviderView[]> {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  if (id.length === 0) throw new ProviderError(400, 'provider id 不能为空');

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (apiKey.length === 0) {
    // dsh's rule for credentials is the opposite of its settings rule: an empty
    // value is never stored, removal is its own operation.
    throw new ProviderError(400, '密钥不能为空；如需清除请使用「断开」');
  }

  const provider = runtime.getProvider(id);
  if (provider === undefined) throw new ProviderError(404, `provider 不存在：${id}`);
  const auth = (provider.auth ?? {}) as RawProviderAuth;
  const method = toMethod(auth.apiKey);
  if (method === undefined) {
    throw new ProviderError(400, `provider ${id} 没有 API key 认证方式`);
  }
  if (!method.interactive) {
    throw new ProviderError(
      400,
      `provider ${id} 的密钥只能来自环境或配置文件，无法在这里写入`,
    );
  }

  const events: AuthEvent[] = [];
  try {
    // `login` runs the provider's own flow and persists through the credential
    // store's single `modify` path — pi's AuthStorage, under its own file lock.
    await runtime.login(id, 'api_key', scriptedInteraction(apiKey, events));
  } catch (error) {
    const detail = events
      .map((event) => ('message' in event ? event.message : undefined))
      .filter((message): message is string => typeof message === 'string' && message.length > 0)
      .join('；');
    throw new ProviderError(
      502,
      `保存密钥失败：${errorMessage(error)}${detail.length > 0 ? `（${detail}）` : ''}`,
    );
  }

  return listProviders(runtime, declaredIds);
}

/**
 * Remove the stored credential for one provider — dsh's `credentials.unset`.
 *
 * `logout` is the runtime's own removal path, so it also clears the runtime's
 * cached auth view; an environment-provided key is unaffected, which is what the
 * refreshed status will then report.
 */
export async function removeProviderCredential(
  runtime: ModelRuntime,
  providerId: string,
  declaredIds: readonly string[],
): Promise<ProviderView[]> {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  if (id.length === 0) throw new ProviderError(400, 'provider id 不能为空');
  if (runtime.getProvider(id) === undefined) {
    throw new ProviderError(404, `provider 不存在：${id}`);
  }

  const stored = (await runtime.listCredentials().catch(() => [] as const)).find(
    (entry) => entry.providerId === id,
  );
  if (stored === undefined) {
    throw new ProviderError(404, `provider ${id} 没有已存储的凭据`);
  }

  try {
    await runtime.logout(id);
  } catch (error) {
    throw new ProviderError(502, `清除凭据失败：${errorMessage(error)}`);
  }
  return listProviders(runtime, declaredIds);
}
