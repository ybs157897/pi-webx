/** Only the named frame's same-origin state messages are accepted by the caller. */
export function readIdeState(message) {
  if (message?.type !== 'web-idea:state') return null
  const state = message.payload
  if (!state || typeof state !== 'object') return null
  const nullableText = value => value === null || typeof value === 'string'
  if (!nullableText(state.root) || !nullableText(state.path) || !nullableText(state.workspaceId)) return null
  if (state.root !== null && (!state.root.startsWith('/') || !state.workspaceId)) return null
  if (typeof state.dirty !== 'boolean' || typeof state.saving !== 'boolean') return null
  return { root: state.root, path: state.path, workspaceId: state.workspaceId, dirty: state.dirty, saving: state.saving }
}
