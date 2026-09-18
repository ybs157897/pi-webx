/**
 * Wire types for the provider list and credential editing.
 *
 * Split from `model-catalog.ts` because they answer different questions, the way
 * dsh keeps `llm.listProviders` and the `credentials` capability apart: the
 * catalog says *what can be run*, this says *what can be configured and whether
 * it is*.
 *
 * The credential view has no slot a value could ride in — dsh's rule for its own
 * `CredentialInfo`, and the same shape pi already reports. `status.source` is a
 * label ("stored", "environment", "models_json_key", …), never a key and never a
 * masked tail.
 */

/** One way a provider accepts credentials. */
export interface ProviderAuthMethod {
  /** True when the provider can be driven from here; an ambient-only key cannot. */
  interactive: boolean;
  /** Provider-supplied display name, e.g. "Anthropic API key". */
  name?: string;
  /** Selector label for an OAuth method. */
  loginLabel?: string;
  /** The method is backed by a provider subscription. */
  subscription?: boolean;
}

/** Whether a provider is usable, and where its credential comes from. */
export interface ProviderCredentialState {
  configured: boolean;
  /** `stored` | `runtime` | `environment` | `fallback` | `models_json_key` | `models_json_command`. */
  source?: string;
  /** Human-readable origin, e.g. an environment variable name. */
  label?: string;
}

/** One row of the settings page's provider list. */
export interface ProviderView {
  id: string;
  name: string;
  methods: {
    apiKey?: ProviderAuthMethod;
    oauth?: ProviderAuthMethod;
  };
  status: ProviderCredentialState;
  /** Credential persisted for this provider, if any. */
  storedCredential: 'api_key' | 'oauth' | null;
  usingOAuth: boolean;
  usingSubscription: boolean;
  /** Advertised model count, 0 when the provider could not be read. */
  modelCount: number;
  /**
   * Declared in `models.json`, so the custom-provider editor owns it. A catalog
   * provider is configured through its credential only.
   */
  declared: boolean;
}

/** `GET /api/providers` */
export interface ListProvidersResponse {
  providers: ProviderView[];
}

/** `PUT /api/providers/:id/credential` — an empty key is refused, not stored. */
export interface SetCredentialRequest {
  apiKey: string;
}

/** Every credential write answers with the whole list, so callers replace state. */
export type CredentialWriteResponse = ListProvidersResponse;

/** Non-secret label for a credential source, for the row's dot tooltip. */
export function credentialSourceLabel(status: ProviderCredentialState): string {
  switch (status.source) {
    case 'stored':
      return '密钥已保存到 pi 的 auth.json';
    case 'runtime':
      return '密钥仅在本进程内有效（未持久化）';
    case 'environment':
      return `密钥来自环境变量${status.label === undefined ? '' : ` ${status.label}`}`;
    case 'fallback':
      return '使用 provider 的兜底凭据';
    case 'models_json_key':
      return '密钥写在 models.json 的 apiKey 字段';
    case 'models_json_command':
      return '密钥由 models.json 的 shell 命令提供';
    default:
      return status.configured ? '已配置凭据' : '未配置凭据';
  }
}
