import CategoryBadge from './CategoryBadge.jsx'

/**
 * 本次会话的一张需求草稿卡：分类徽标 + 标题 + 待办条数 + 导入入口。
 * 已导入的转「查看待办」；被群里接手（chatroom_send 已转交）且还没导入的，
 * 按钮锁成「已转交群处理」，避免在群里和页面两边重复导入同一份草稿。
 */
export default function RequirementDraftCard({ row, dispatched = false, busy = false, onImport, onOpenTasks }) {
  const imported = Boolean(row.importedAt)
  const handedOff = dispatched && !imported
  return <div className="req-draft" data-testid="req-draft">
    <div>
      <span className="req-draft-label">{imported ? '已导入待办' : '需求草稿已整理'}<CategoryBadge value={row.category} testid="req-draft-category" /></span>
      <strong>{row.title}</strong>
      <span className="req-draft-count">{row.taskDrafts?.length ?? 0} 项待办{imported ? ' · 可在待办中跟进' : ' · 预览并确认后导入'}</span>
      {handedOff && <span className="req-draft-dispatched" data-testid="req-draft-dispatched">已转交群处理 · 请勿重复导入</span>}
    </div>
    <button type="button" className="btn btn-primary btn-sm" data-testid="req-draft-import" disabled={busy || handedOff} onClick={() => imported ? onOpenTasks(row.id) : onImport(row)}>{imported ? '查看待办' : handedOff ? '已转交群处理' : '预览并导入待办'}</button>
  </div>
}
