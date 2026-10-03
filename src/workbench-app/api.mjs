/** Workbench records live in pi-webx's SQLite service; chat uses its session client. */
const ROOT = '/api/workbench'
const JSON_HEADERS = { 'content-type': 'application/json' }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

async function request(path, { method = 'GET', body, cache } = {}) {
  const response = await fetch(`${ROOT}${path}`, {
    method,
    headers: body === undefined ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache,
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    const error = new Error(`工作台服务返回了非 JSON 内容（${response.status}）`)
    error.status = response.status
    throw error
  }
  if (!response.ok) {
    const error = new Error(payload?.error ?? `工作台请求失败（${response.status}）`)
    error.status = response.status
    throw error
  }
  if (payload === null) throw new Error('工作台服务返回了空响应')
  return payload
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 拆掉接口信封：PUT /prefs 的回包和 GET /prefs、/state 一样都是 `{prefs:{…}}`，
 *  而调用方（usePrefs.setPref）要的是裸 prefs 对象。不拆就会把信封整份当成偏好灌进
 *  state——每写一个键，theme / density / panelOpen 等其余键全被冲掉。 */
function unwrapPrefs(payload) {
  return isRecord(payload) && isRecord(payload.prefs) ? payload.prefs : payload
}

async function imageDataUrl(file) {
  if (!file || !IMAGE_TYPES.has(file.type)) throw new Error('只能上传 png、jpeg、webp 或 gif 图片')
  if (file.size > 5 * 1024 * 1024) throw new Error('图片超过 5MB 上限')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

async function getRequirementImportContext(id) {
  const payload = await request('/state', { cache: 'no-store' })
  const requirements = payload?.data?.requirements
  const tasks = payload?.data?.tasks
  if (!Array.isArray(requirements) || !Array.isArray(tasks)) {
    throw new Error('工作台状态缺少需求或待办记录列表')
  }
  return {
    record: requirements.find((record) => record?.id === id) ?? null,
    linkedTasks: tasks
      .filter((task) => Array.isArray(task?.refs)
        && task.refs.some((ref) => ref?.type === 'requirements' && ref?.id === id))
      .map((task) => ({
        id: task.id,
        title: String(task.title ?? ''),
        due: task.due ?? null,
        done: Boolean(task.done),
      })),
  }
}

export const api = {
  state: () => request('/state'),
  getRequirementImportContext,
  getRequirement: async (id) => (await getRequirementImportContext(id)).record,
  exportData: () => request('/export'),
  importData: (data) => request('/import', { method: 'POST', body: data }),
  addRecord: (module, fields) => request(`/${module}`, { method: 'POST', body: fields }),
  importRequirement: (id, body) => request(`/requirements/${encodeURIComponent(id)}/import-tasks`, { method: 'POST', body }),
  patchRecord: (module, id, patch) => request(`/${module}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  removeRecord: (module, id) => request(`/${module}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  search: (query) => request(`/search?q=${encodeURIComponent(query)}`),
  links: (module, id) => request(`/links/${encodeURIComponent(module)}/${encodeURIComponent(id)}`),
  setPrefs: async (patch) => unwrapPrefs(await request('/prefs', { method: 'PUT', body: patch })),
  loadDemo: () => request('/demo-data', { method: 'POST' }),
  clearAll: () => request('/demo-data', { method: 'DELETE' }),
  upload: imageDataUrl,
}
