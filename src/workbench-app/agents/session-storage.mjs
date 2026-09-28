// Normalize browser-provided project roots before keying pointers and drafts.
// The server resolves symlinks with realpath before using the directory as SDK cwd.
export function normalizeProjectCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null
  const parts = []
  for (const part of cwd.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
export const agentStorageKey = (agentId, cwd) => agentId === 'codes'
  ? `ai-workbench.agent-session:default:codes:${encodeURIComponent(normalizeProjectCwd(cwd) ?? '')}`
  : `ai-workbench.agent-session:default:${agentId}`
export function readPointer(key) {
  if (typeof window === 'undefined') return null
  try {
    const own = window.sessionStorage.getItem(key)
    if (own !== null) return own || null
    const recent = window.localStorage.getItem(key)
    if (recent) window.sessionStorage.setItem(key, recent)
    return recent
  } catch { return null }
}
export function writePointer(key, id) {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(key, id); window.localStorage.setItem(key, id) } catch { /* storage unavailable */ }
}
export function clearPointer(key) {
  if (typeof window === 'undefined') return
  // Empty marker keeps this tab's explicit new conversation independent of another tab's pointer.
  try { window.sessionStorage.setItem(key, '') } catch { /* storage unavailable */ }
}
export function readDraft(key) {
  if (typeof window === 'undefined') return ''
  try { return window.sessionStorage.getItem(`${key}:draft`) ?? '' } catch { return '' }
}
export function writeDraft(key, text) {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.setItem(`${key}:draft`, text) } catch { /* storage unavailable */ }
}
