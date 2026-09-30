import { durationText } from '../tasks/model.jsx'

export default function TodayOverview({ board, progress, candidatesOpen, onToggleCandidates }) {
  return <section className="assistant-overview" data-testid="assistant-overview" aria-label="当天概览">
    <div className="today-overview-grid" data-testid="today-overview-grid">
      <div className="today-stat-card" data-testid="today-stat-scheduled">
        <span className="today-stat-label">已排事项</span>
        <strong className="today-stat-value">{board.open.length}<small>件未完成</small></strong>
        <span className="today-stat-hint">预计 {durationText(board.openMinutes)}</span>
      </div>
      <button type="button" className="today-stat-card is-action" data-testid="assistant-overview-pending" aria-expanded={candidatesOpen} onClick={onToggleCandidates}>
        <span className="today-stat-label">待安排</span>
        <strong className="today-stat-value" data-testid="today-stat-pending">{board.candidates.length}<small>件待办</small></strong>
        <span className="today-stat-hint">从待办里挑选 →</span>
      </button>
      <div className="today-stat-card" data-testid="today-stat-slack">
        <span className="today-stat-label">时段余量</span>
        <strong className="today-stat-value is-text">{board.slack === null ? '待确定' : durationText(board.slack)}</strong>
        <span className="today-stat-hint">{board.slack === null ? '至少排两件定时事项后计算' : '已排时段之间的空闲'}</span>
      </div>
      <div className="today-stat-card is-progress" data-testid="today-stat-completed">
        <span className="today-stat-label">当天完成</span>
        <strong className="today-stat-value">{board.done.length}<small>/ {board.scheduled.length} 件</small></strong>
        <span className="today-stat-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></span>
      </div>
    </div>
  </section>
}
