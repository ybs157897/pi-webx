export default function TaskOverview({ stats }) {
  const cards = [
    { key: 'open', label: '未完成', value: stats.open, hint: '全部待办中' },
    { key: 'planned', label: '今天安排', value: stats.planned, hint: `其中 ${stats.plannedDone} 件已完成` },
    { key: 'overdue', label: '已逾期', value: stats.overdue, hint: '截止日早于今天' },
    { key: 'done', label: '已完成', value: stats.done, hint: '全部待办中' },
  ]

  return <section className="tasks-overview" data-testid="tasks-overview" aria-label="待办概览">
    <div className="tasks-section-heading">
      <div>
        <h2>待办概览</h2>
        <p>根据全部待办实时统计</p>
      </div>
      <span className="tasks-overview-total">共 {stats.total} 件</span>
    </div>
    <div className="tasks-overview-grid">
      {cards.map(card => <div className={`tasks-stat-card is-${card.key}`} key={card.key} data-testid={`tasks-stat-${card.key}`}>
        <span className="tasks-stat-label">{card.label}</span>
        <strong className="tasks-stat-value">{card.value}<small>件</small></strong>
        <span className="tasks-stat-hint">{card.hint}</span>
      </div>)}
    </div>
  </section>
}
