/**
 * Section copy for the Models settings UI (pi-webx is a Chinese-UI app, so the
 * dsh locale system collapses to one static table), plus the provider-label
 * helpers the destructive-action copy substitutes into.
 */

export const copy = {
  title: '模型',
  intro: '填入各提供方的 API 密钥即可使用其模型。',
  loadFailed: '加载失败',
  retry: '重试',
  savedProvider: '已保存 {provider}',
  edit: '编辑',
  remove: '删除',
  editProvider: '编辑 {provider}',
  removeProvider: '删除 {provider}',
  credentialConfigured: '密钥已配置',
  credentialMissing: '未配置密钥',
  deleteTitle: '删除 {provider}',
  deleteDescription: '将从 models.json 中删除该 provider 及其已存储的密钥。',
  customTag: '自定义',
  generalTitle: '通用设置',
  generalIntro: '界面外观与 agent 内容的渲染方式。',
  appearance: '外观',
  appearanceHint: '跟随系统时会随系统深浅色切换。',
  themeLight: '浅色',
  themeDark: '深色',
  themeSystem: '跟随系统',
  renderer: '渲染引擎',
  rendererHint: 'agent 输出的界面组件由哪一个渲染器绘制。',
  rendererOurs: '自研',
  rendererTokui: 'TokUI',
  deleteConfirm: '删除',
  deleting: '删除中…',
  cancel: '取消',
  close: '关闭',
  apply: '保存',
  applying: '保存中…',
  create: '创建',
  creating: '创建中…',
  keyInput: 'API 密钥',
  keyPlaceholder: '粘贴 API 密钥',
  keyBlank: '密钥不能只包含空白字符',
  keyIllegalCharacters: '密钥包含非法字符：仅支持可打印 ASCII（不含空格），且不能是带引号或 NAME=value 形式的粘贴',
  clearStoredKey: '清除已存储的密钥',
  customized: '自定义设置',
  customDisplayName: '显示名称',
  baseUrl: 'Base URL',
  baseUrlDefault: 'https://api.example.com/v1',
  baseUrlInvalid: 'Base URL 不是合法的 http/https 地址',
  customApi: 'API 类型',
  customApiUnset: '未设置（跟随各模型）',
  authHeader: '鉴权请求头',
  authHeaderDefault: '提供商默认',
  authHeaderForce: '强制 Authorization 头',
  models: '模型列表',
  modelsEmpty: '尚未配置模型',
  addModel: '添加模型',
  model: '模型',
  modelId: '模型 ID',
  modelName: '显示名称',
  modelAdvanced: '高级设置',
  removeModel: '移除模型',
  modelContextWindow: '上下文窗口',
  modelMaxTokens: '最大输出',
  modelImageInput: '图片输入',
  modelImageInputHint: '可发送图片',
  modelIdRequired: '模型 ID 不能为空',
  modelIdDuplicate: '模型 ID 重复',
  modelContextInvalid: '上下文窗口必须是正整数，可写 256K / 1M',
  modelMaxTokensInvalid: '最大输出必须是正整数，可写 32K / 1M',
  fetchModels: '拉取可用模型',
  fetching: '拉取中…',
  fetchNeedsBaseUrl: '需要先填写 Base URL',
  fetchEmpty: '该端点未返回任何模型',
  fetchTitle: '选择要添加的模型',
  fetchDescription: '勾选要加入配置的条目；已配置的模型默认不勾选，不会被覆盖。',
  fetchSearch: '搜索模型',
  fetchSelectAll: '全选',
  fetchDeselectAll: '取消全选',
  fetchNoMatches: '没有匹配的模型',
  fetchAdopt: '添加所选',
  add: '添加提供方',
  addCustom: '添加自定义提供方',
  provider: '提供方',
  keyReplacePlaceholder: '已配置——输入新值可替换',
  delete: '删除',
  customTitle: '添加 Provider',
  customRoute: 'Provider ID',
  customRouteInvalid: 'ID 只能包含字母、数字、点、下划线和连字符，且以字母或数字开头',
  customRouteTaken: '该 ID 已存在',
  customRouteHint: '在 models.json 中标识该 provider，例如 acme-gateway',
  customBaseUrlPlaceholder: 'https://api.example.com/v1',
  customNeedsBaseUrl: '需要填写 Base URL',
  customNeedsModels: '至少配置一个模型',
  loading: '正在加载…',
  disconnect: '断开',
  oauthOnly: '使用 OAuth 登录（暂未接入）',
  ambientOnly: '密钥来自环境变量或配置文件',
  keyStoredByProviderFlow: '密钥通过该 Provider 自己的登录流程写入 auth.json；本页永远不会把它读回来。',
} as const

export type CopyKey = keyof typeof copy

/** The section's static localizer. */
export function t(key: CopyKey): string {
  return copy[key]
}

/** Stable visible identity for one provider target. */
export function providerTargetLabel(target: { id: string; name?: string }): string {
  const displayName = target.name !== undefined && target.name.length > 0 ? target.name : target.id
  return target.id === displayName ? target.id : `${displayName}（${target.id}）`
}

/** Replace the one provider placeholder in destructive-action copy. */
export function providerCopy(template: string, target: { id: string; name?: string }): string {
  return template.replace('{provider}', () => providerTargetLabel(target))
}

/**
 * Browser-side judgement of a typed API key, ported from dsh's `apiKey.ts`:
 * printable ASCII with space excluded; a wrapped paste or a `NAME=value`
 * environment line is refused rather than stored.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

export type ApiKeyFailureKey = 'keyBlank' | 'keyIllegalCharacters'

/** Whether a value is wrapped in one matching pair of quotes. */
function isQuoted(value: string): boolean {
  const first = value[0]
  if (first !== '"' && first !== '\'' && first !== '`') return false
  return value.length > 1 && value.endsWith(first)
}

/**
 * Judge the key input's current value. An empty field is not a failure: every
 * card opens with it empty even when a key is already stored, where it means
 * keep that one. A field holding only whitespace is a failure, so typed input
 * is never silently discarded.
 */
export function apiKeyFailure(draft: string): ApiKeyFailureKey | undefined {
  if (draft.length === 0) return undefined
  const value = draft.trim()
  if (value.length === 0) return 'keyBlank'
  if (ENV_LINE.test(value) || isQuoted(value)) return 'keyIllegalCharacters'
  if (!LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
  return undefined
}
