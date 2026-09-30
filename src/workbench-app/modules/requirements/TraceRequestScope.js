/** Owns one drawer's asynchronous results; stale or unmounted requests cannot update it. */
export function createTraceRequestScope(initialId = '') {
  let active = false
  let currentId = initialId
  let revision = 0
  let mutation = null

  return {
    activate() {
      active = true
      mutation = null
      revision += 1
    },
    deactivate() {
      active = false
      mutation = null
      revision += 1
    },
    isActive() { return active },
    isBusy() { return mutation !== null },
    switchTo(id) {
      if (!active || mutation) return false
      currentId = id
      revision += 1
      return true
    },
    beginLookup(id) {
      if (!active || mutation || currentId !== id) return null
      return { kind: 'lookup', id, revision: ++revision }
    },
    beginMutation(id) {
      if (!active || mutation || currentId !== id) return null
      mutation = { kind: 'mutation', id, revision: ++revision }
      return mutation
    },
    isCurrent(token) {
      return Boolean(active && token && token.id === currentId && token.revision === revision
        && (token.kind !== 'mutation' || mutation === token))
    },
    finishMutation(token) {
      if (mutation === token) mutation = null
    },
  }
}
