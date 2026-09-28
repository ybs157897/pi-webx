const SETTINGS_URL = '/api/module-agents/codes/settings'

function isAbsoluteDirectory(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && (
    value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
  )
}

/** The editor opens the Agent's configured workspace; only Agent settings can change it. */
export async function readConfiguredCodeWorkspace({ signal, request = fetch } = {}) {
  const response = await request(SETTINGS_URL, { signal })
  let settings
  try { settings = await response.json() }
  catch { throw new Error('代码 Agent 配置响应无效') }
  if (!response.ok) throw new Error(typeof settings?.error === 'string' && settings.error
    ? settings.error : '无法读取代码 Agent 工作区配置')
  if (!isAbsoluteDirectory(settings?.workspacePath)) {
    throw new Error('代码 Agent 未配置有效的绝对工作区目录，请先在 Agent 配置中设置')
  }
  return settings.workspacePath
}
