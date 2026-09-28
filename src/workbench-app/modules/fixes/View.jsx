import { Fragment } from 'react'

import { Card, Chip, ChipButton, Empty, IconButton, Segmented } from '../../ui.jsx'
import {
  IconBug,
  IconChevronRight,
  IconEdit,
  IconLogs,
  IconPlus,
  IconSearch,
  IconTasks,
  IconTrash
} from '../../icons.jsx'
import { formatDay, formatStamp, relativeDay } from '../../util.mjs'

import {
  TEXT,
  STATUS_OPTIONS,
  TAG_LIMIT,
  LOG_LIMIT,
  priorityOf,
  statusOf,
  levelOf,
  tagsOf,
  TagChips
} from './model.jsx'

import Dialogs from './Dialogs.jsx'

export default function View(props) {
  const { fixes, empty, onLoadDemo, demoBusy, loadDemo, openForm, subtitle, submitQuick, quick, quickBusy, setQuick, keyword, setKeyword, statusOptions, status, setStatus, priorityChips, priorities, togglePriority, tagPool, visibleTags, tags, toggleTag, setAllTags, allTags, hasFilter, clearFilters, rows, openId, tasksOfFix, logsOfFix, setOpenId, changeStatus, today, setPendingDelete, navigate, openLog, form, busy, setForm, submitForm, logFor, setLogFor, submitLog, logDraft, setLogDraft, pendingDelete, confirmDelete } = props
  return (
    <div className="fixes" data-module="fixes">
      {fixes.length === 0 ? (
        <div data-testid="fixes-empty">
          <Card>
            <Empty
              icon={<IconBug size={22} />}
              title={TEXT.empty}
              hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
              action={(
                <div className="fixes-guide-actions">
                  {empty === true && typeof onLoadDemo === 'function' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="fixes-load-demo"
                      disabled={demoBusy}
                      onClick={loadDemo}
                    >
                      {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => openForm()}>
                    <IconPlus size={15} />
                    {TEXT.create}
                  </button>
                </div>
              )}
            />
          </Card>
        </div>
      ) : (
        <Card
          className="fixes-panel"
          title={TEXT.title}
          subtitle={subtitle}
          action={(
            <button type="button" className="btn btn-sm btn-primary" onClick={() => openForm()}>
              <IconPlus size={15} />
              {TEXT.create}
            </button>
          )}
        >
          <form className="fixes-quick" data-testid="fixes-quick-add" onSubmit={submitQuick}>
            <IconPlus className="fixes-quick-icon" size={15} />
            <input
              className="input"
              value={quick}
              disabled={quickBusy}
              aria-label={TEXT.quickAdd}
              placeholder={TEXT.quickAdd}
              onChange={event => setQuick(event.target.value)}
            />
          </form>

          <div className="fixes-toolbar">
            <div className="fixes-toolbar-row">
              <label className="fixes-search">
                <IconSearch size={15} />
                <input
                  className="fixes-search-input"
                  type="search"
                  value={keyword}
                  placeholder={TEXT.search}
                  aria-label={TEXT.searchLabel}
                  onChange={event => setKeyword(event.target.value)}
                />
              </label>
              <Segmented options={statusOptions} value={status} onChange={setStatus} label={TEXT.filterLabel} />
            </div>

            <div className="fixes-toolbar-row fixes-chips">
              <span className="fixes-chip-label">{TEXT.priorityFilter}</span>
              <div className="fixes-chip-group" role="group" aria-label={TEXT.priorityFilter} data-testid="fixes-priority-filter">
                {priorityChips.map(option => (
                  <ChipButton
                    key={option.value}
                    tone={option.tone}
                    active={priorities.includes(option.value)}
                    title={`${option.label}优先级 ${option.count} 条`}
                    onClick={() => togglePriority(option.value)}
                  >
                    {option.label} {option.count}
                  </ChipButton>
                ))}
              </div>

              {tagPool.length > 0 && (
                <>
                  <span className="fixes-chip-label">{TEXT.tagFilter}</span>
                  <div className="fixes-chip-group" role="group" aria-label={TEXT.tagFilter} data-testid="fixes-tag-filter">
                    {visibleTags.map(tag => (
                      <ChipButton
                        key={tag.value}
                        active={tags.includes(tag.value)}
                        title={`#${tag.value} ${tag.count} 条`}
                        onClick={() => toggleTag(tag.value)}
                      >
                        #{tag.value} {tag.count}
                      </ChipButton>
                    ))}
                  </div>
                  {tagPool.length > TAG_LIMIT && (
                    <button type="button" className="fixes-plain" onClick={() => setAllTags(current => !current)}>
                      {allTags ? TEXT.lessTags : `${TEXT.moreTags} ${tagPool.length}`}
                    </button>
                  )}
                </>
              )}

              {hasFilter && (
                <button type="button" className="fixes-plain fixes-clear" onClick={clearFilters}>{TEXT.clearFilter}</button>
              )}
            </div>
          </div>

          {rows.length === 0 ? (
            <div data-testid="fixes-filtered-empty">
              <Empty
                icon={<IconSearch size={20} />}
                title={TEXT.filteredEmpty}
                hint={TEXT.filteredEmptyHint}
                action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
              />
            </div>
          ) : (
            <div className="table fixes-table" data-testid="fixes-list">
              <div className="table-head">
                <span className="fixes-pri">{TEXT.fieldPriority}</span>
                <span className="fixes-title">{TEXT.fieldTitle}</span>
                <span className="fixes-status">{TEXT.fieldStatus}</span>
                <span className="fixes-tags">{TEXT.fieldTags}</span>
                <span className="fixes-time">{TEXT.colTime}</span>
                <span className="sr-only">{TEXT.colActions}</span>
              </div>

              {rows.map(fix => {
                const priority = priorityOf(fix.priority)
                const fixTags = tagsOf(fix)
                const stamp = fix.updatedAt ?? fix.createdAt
                const expanded = openId === fix.id
                const title = String(fix.title ?? '')
                const note = String(fix.note ?? '').trim()
                const linkedTasks = expanded ? tasksOfFix(fix) : []
                const linkedLogs = expanded ? logsOfFix(fix) : []

                return (
                  <Fragment key={fix.id}>
                    <div className="table-row fixes-row" data-testid="fix-row">
                      <span className="fixes-pri" title={`${TEXT.fieldPriority} ${priority.label}`}>
                        <span className={`fixes-dot ${priority.tone}`} aria-hidden="true" />
                        <span className="sr-only">{TEXT.fieldPriority}</span>
                        {priority.label}
                      </span>
                      <button
                        type="button"
                        className="fixes-title"
                        aria-expanded={expanded}
                        title={title}
                        onClick={() => setOpenId(expanded ? null : fix.id)}
                      >
                        <IconChevronRight className="fixes-caret" size={14} />
                        <span className="fixes-title-text">{title}</span>
                      </button>
                      <span className="fixes-status">
                        <Segmented
                          options={STATUS_OPTIONS}
                          value={statusOf(fix.status).value}
                          onChange={next => changeStatus(fix, next)}
                          label={`「${title}」${TEXT.fieldStatus}`}
                        />
                      </span>
                      <TagChips tags={fixTags} />
                      <time className="fixes-time" dateTime={typeof stamp === 'string' ? stamp : undefined}>
                        {formatStamp(stamp, today)}
                      </time>
                      <span className="fixes-row-actions">
                        <IconButton label={`${TEXT.editAction}「${title}」`} onClick={() => openForm(fix)}>
                          <IconEdit size={16} />
                        </IconButton>
                        <IconButton label={`${TEXT.delete}「${title}」`} tone="danger" onClick={() => setPendingDelete(fix)}>
                          <IconTrash size={16} />
                        </IconButton>
                      </span>
                    </div>

                    {expanded && (
                      <div className="fixes-detail" data-testid="fix-detail">
                        <div className="fixes-detail-meta">
                          <span className="fixes-detail-tags">
                            {fixTags.length === 0
                              ? <span className="fixes-muted">{TEXT.noTags}</span>
                              : fixTags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
                          </span>
                          <span className="fixes-muted xs">
                            {TEXT.createdAt} {formatStamp(fix.createdAt, today)}
                            {' · '}
                            {TEXT.updatedAt} {formatStamp(stamp, today)}
                          </span>
                        </div>

                        <div className="fixes-detail-grid">
                          <section className="fixes-block">
                            <h4 className="fixes-block-title">{TEXT.fieldNote}</h4>
                            {note === ''
                              ? <p className="fixes-muted">{TEXT.noNote}</p>
                              : <p className="fixes-note">{note}</p>}
                          </section>

                          <div className="fixes-side">
                            <section className="fixes-block">
                              <div className="fixes-block-head">
                                <h4 className="fixes-block-title">{TEXT.relatedTasks}</h4>
                                <Chip>{linkedTasks.length}</Chip>
                                <button type="button" className="fixes-plain" onClick={() => navigate('tasks')}>
                                  <IconTasks size={13} />
                                  {TEXT.goTasks}
                                </button>
                              </div>
                              {linkedTasks.length === 0
                                ? (
                                  <p className="fixes-muted">
                                    {TEXT.noTasks}
                                    <span className="fixes-block-hint">{TEXT.noTasksHint}</span>
                                  </p>
                                )
                                : (
                                  <ul className="fixes-links">
                                    {linkedTasks.map(task => (
                                      <li key={task.id}>
                                        <button type="button" className="fixes-link" onClick={() => navigate('tasks')}>
                                          <IconTasks size={14} />
                                          <span className="fixes-link-text">{String(task.title ?? '')}</span>
                                          {task.done === true
                                            ? <Chip tone="ok">{TEXT.taskDone}</Chip>
                                            : <Chip tone="warn">{TEXT.taskTodo}</Chip>}
                                          {typeof task.due === 'string' && task.due !== '' && (
                                            <span className="fixes-link-meta">{relativeDay(task.due, today)}</span>
                                          )}
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                            </section>

                            <section className="fixes-block">
                              <div className="fixes-block-head">
                                <h4 className="fixes-block-title">{TEXT.relatedLogs}</h4>
                                <Chip>{linkedLogs.length}</Chip>
                                <button type="button" className="btn btn-sm" onClick={() => openLog(fix)}>
                                  <IconLogs size={14} />
                                  {TEXT.logAction}
                                </button>
                                <button type="button" className="fixes-plain" onClick={() => navigate('logs')}>
                                  {TEXT.goLogs}
                                </button>
                              </div>
                              {linkedLogs.length === 0
                                ? <p className="fixes-muted">{TEXT.noLogs}</p>
                                : (
                                  <ul className="fixes-links">
                                    {linkedLogs.slice(0, LOG_LIMIT).map(log => (
                                      <li key={log.id} className="fixes-log">
                                        <Chip tone={levelOf(log.level).tone}>{levelOf(log.level).label}</Chip>
                                        <span className="fixes-log-text">{String(log.text ?? '')}</span>
                                        <span className="fixes-link-meta">{formatDay(log.date)}</span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              {linkedLogs.length > LOG_LIMIT && (
                                <p className="fixes-muted xs">{TEXT.moreLogs(linkedLogs.length - LOG_LIMIT)}</p>
                              )}
                            </section>
                          </div>
                        </div>
                      </div>
                    )}
                  </Fragment>
                )
              })}
            </div>
          )}
        </Card>
      )}

      <Dialogs {...props} />
    </div>
  )
}
