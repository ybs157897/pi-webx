/**
 * The search body of the workspace browser: local metadata matches across both
 * session kinds, rendered as one flat result list.
 */
import { useMemo } from 'react'
import clsx from 'clsx'
import type { SessionSummary, StoredSession } from '../../shared/protocol'
import type { SessionNode, WorkspaceItem } from './tree.ts'
import { deriveSearchResults } from './tree.ts'
import { SearchResultItem } from './Rows.tsx'
import css from './WorkspaceBrowser.module.css'

/** The flat search body: local metadata matches across both session kinds. */
export function SessionSearchResults({ query, workspaces, live, stored, currentId, completed, openResult }: {
  query: string
  workspaces: readonly WorkspaceItem[]
  live: readonly SessionSummary[]
  stored: readonly StoredSession[]
  currentId: string | null
  completed: ReadonlySet<string>
  openResult: (node: SessionNode | { id: string; kind: 'live' | 'stored' }) => void
}) {
  const results = useMemo(
    () => deriveSearchResults(workspaces, live, stored, query, completed),
    [workspaces, live, stored, query, completed],
  )
  return (
    <div className={clsx(css.treeBody, css.wide)}>
      <div className={css.list}>
        <div className={css.searchTree} role="tree" aria-label="搜索结果">
          {results.map(result => (
            <SearchResultItem
              key={`${result.kind}:${result.id}`}
              result={result}
              currentId={currentId ?? undefined}
              onOpen={openResult}
            />
          ))}
        </div>
        {results.length === 0 && (
          <div className={css.empty}>没有匹配的会话</div>
        )}
      </div>
      <span className={css.fade} />
    </div>
  )
}
