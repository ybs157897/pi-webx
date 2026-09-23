/** Workbench records live in pi-webx's SQLite service; chat uses its session client. */
const ROOT = '/api/workbench'
const JSON_HEADERS = { 'content-type': 'application/json' }
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${ROOT}${path}`, {
    method,
    headers: body === undefined ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(`工作台服务返回了非 JSON 内容（${response.status}）`)
  }
  if (!response.ok) throw new Error(payload?.error ?? `工作台请求失败（${response.status}）`)
  if (payload === null) throw new Error('工作台服务返回了空响应')
  return payload
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

export const api = {
  state: () => request('/state'),
  exportData: () => request('/export'),
  importData: (data) => request('/import', { method: 'POST', body: data }),
  addRecord: (module, fields) => request(`/${module}`, { method: 'POST', body: fields }),
  patchRecord: (module, id, patch) => request(`/${module}/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  removeRecord: (module, id) => request(`/${module}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  putAtomProfile: (module, patch) => request(`/atoms/${module}`, { method: 'PUT', body: patch }),
  addAtomRecord: (module, fields) => request(`/atoms/${module}/records`, { method: 'POST', body: fields }),
  patchAtomRecord: (module, id, patch) => request(`/atoms/${module}/records/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  removeAtomRecord: (module, id) => request(`/atoms/${module}/records/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  upload: imageDataUrl,
}
