

import { Chip, IconButton, Segmented } from '../../ui.jsx'
import { IconChevronLeft, IconChevronRight, IconEdit, IconStar, IconTasks, IconTrash } from '../../icons.jsx'
import { formatStamp } from '../../util.mjs'
import AssistantMarkdown from '../../pi-webx/AssistantMarkdown.jsx'
import './Requirements.css'

import { TEXT, STATUS_STEPS, priorityOf, statusOf, tagsOf } from './model.jsx'

export default function Reader({
  row, linkedTasks, stepBack, stepNext, onStatus,
  onStar, onEdit, onDelete, onMove, onNavigate, onImport, onTrace,
}) {
  const priority = priorityOf(row.priority)
  const step = statusOf(row.status)
  const tags = tagsOf(row)
  const title = String(row.title ?? '')
  const note = String(row.note ?? '').trim()
  const starred = row.starred === true
  // 导入来的记录可能没有时间戳：有才渲染，别留下「创建 」这样的半截文案。
  const created = typeof row.createdAt === 'string' ? row.createdAt : ''
  const updated = typeof row.updatedAt === 'string' ? row.updatedAt : created

  function goTasks() {
    if (typeof onNavigate === 'function') onNavigate('tasks', { scope: 'all', requirementId: row.id })
  }

  return (
    <>
      <header className="req-reader-head">
        <h2 className="req-reader-title" data-testid="req-reader-title">{title}</h2>
        <div className="req-reader-tools">
          {typeof onTrace === 'function' && <button type="button" className="btn btn-sm"
            data-testid="req-trace-open" onClick={onTrace}>全链路追踪</button>}
          {typeof onImport === 'function' && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="req-import-open"
              onClick={row.importedAt ? goTasks : onImport}
            >
              <IconTasks size={15} />
              {row.importedAt ? '查看已导入待办' : '拆分并导入待办'}
            </button>
          )}
          <span className="req-star-slot" data-testid="req-star">
            <IconButton
              label={starred ? TEXT.unstar : TEXT.star}
              className={`req-star ${starred ? 'is-on' : ''}`}
              onClick={onStar}
            >
              <IconStar size={17} />
            </IconButton>
          </span>
          <button type="button" className="btn btn-sm" data-testid="req-edit" onClick={onEdit}>
            <IconEdit size={15} />
            {TEXT.editAction}
          </button>
          <button
            type="button"
            className="btn btn-sm req-btn-danger"
            data-testid="req-delete"
            onClick={onDelete}
          >
            <IconTrash size={15} />
            {TEXT.delete}
          </button>
        </div>
      </header>

      <div className="req-reader-badges">
        <Segmented
          options={STATUS_STEPS.map(item => ({ value: item.value, label: item.label }))}
          value={step.value}
          onChange={onStatus}
          label={`「${title}」${TEXT.fieldStatus}`}
        />
        <Chip tone={priority.tone}>{TEXT.priorityLabel} {priority.label}</Chip>
      </div>

      <div className="req-reader-meta" data-testid="req-reader-meta">
        <span className="req-reader-tags">
          {tags.length === 0
            ? <span className="req-muted">{TEXT.noTags}</span>
            : tags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
        </span>
        {(created !== '' || updated !== '') && (
          <span className="req-times">
            {created !== '' && `${TEXT.metaCreated} ${formatStamp(created)}`}
            {created !== '' && updated !== '' && ' · '}
            {updated !== '' && `${TEXT.metaUpdated} ${formatStamp(updated)}`}
          </span>
        )}
      </div>

      <div className="req-reader-body" data-testid="req-reader-body">
        {note === ''
          ? <p className="req-note-empty">{TEXT.noNote}</p>
          : <AssistantMarkdown text={note} />}
      </div>

      <section className="req-section" data-testid="req-related">
        <div className="req-section-head">
          <h3 className="req-section-title">{TEXT.relatedTasks}</h3>
          <Chip>{linkedTasks.length}</Chip>
          {linkedTasks.length > 0 && typeof onNavigate === 'function' && (
            <button type="button" className="req-plain" onClick={goTasks}>
              {TEXT.goTasks}
              <IconChevronRight size={13} />
            </button>
          )}
        </div>
        {linkedTasks.length === 0
          ? (
            <p className="req-muted">
              {TEXT.noTasks}
              <span className="req-hint">{TEXT.noTasksHint}</span>
            </p>
          )
          : (
            <ul className="req-tasks">
              {linkedTasks.map(task => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="req-task"
                    data-testid="req-task"
                    onClick={goTasks}
                  >
                    <IconTasks className="req-task-icon" size={15} />
                    <span className="req-task-title">{String(task.title ?? '')}</span>
                    {task.done === true
                      ? <Chip tone="ok">{TEXT.taskDone}</Chip>
                      : <Chip tone="warn">{TEXT.taskTodo}</Chip>}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>

      <div className="req-actions">
        <button
          type="button"
          className="btn"
          data-testid="req-back"
          disabled={stepBack === null}
          title={stepBack === null ? undefined : TEXT.backTo(stepBack.label)}
          aria-label={stepBack === null ? `${TEXT.back}（${TEXT.backLimit}）` : TEXT.backTo(stepBack.label)}
          onClick={() => onMove(stepBack)}
        >
          <IconChevronLeft size={16} />
          {TEXT.back}
        </button>
        <button
          type="button"
          className="btn btn-primary req-advance"
          data-testid="req-advance"
          disabled={stepNext === null}
          title={stepNext === null ? undefined : TEXT.advanceTo(stepNext.label)}
          aria-label={stepNext === null ? `${TEXT.advance}（${TEXT.advanceLimit}）` : TEXT.advanceTo(stepNext.label)}
          onClick={() => onMove(stepNext)}
        >
          {TEXT.advance}
          <IconChevronRight size={16} />
        </button>
      </div>
    </>
  )
}
