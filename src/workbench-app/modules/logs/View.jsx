import { Fragment } from 'react'

import { Card, Chip, ChipButton, Empty, IconButton } from '../../ui.jsx'
import { IconChevronRight, IconLogs, IconPlus, IconSearch, IconTrash } from '../../icons.jsx'
import { formatDay, formatTime } from '../../util.mjs'

export { logsAgentPanel } from './agent-ui.js'

import { TEXT, LEVEL_OPTIONS, SOURCE_LIMIT, levelOf, isRecent, groupLabel, stampText } from './model.jsx'

export default function View(props) {
  const { logs, empty, onLoadDemo, demoBusy, loadDemo, openRecord, hasFilter, rows, filters, setFilters, levelCounts, toggleLevel, sourcePool, visibleSources, pickSource, setAllSources, allSources, levels, clearFilters, groups, today, openId, setOpenId, setPendingDelete } = props
  return (
    <div className="logs" data-module="logs">
      {logs.length === 0 ? (
        <Card>
          <div data-testid="logs-empty">
            <Empty
              icon={<IconLogs size={22} />}
              title={TEXT.empty}
              hint={empty === true ? TEXT.emptyDemoHint : TEXT.emptyHint}
              action={(
                <div className="logs-guide-actions">
                  {empty === true && typeof onLoadDemo === 'function' && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-testid="logs-load-demo"
                      disabled={demoBusy}
                      onClick={loadDemo}
                    >
                      {demoBusy ? TEXT.loadingDemo : TEXT.loadDemo}
                    </button>
                  )}
                  <button type="button" className="btn" data-testid="logs-record-open-empty" onClick={openRecord}>
                    <IconPlus size={15} />
                    {TEXT.record}
                  </button>
                </div>
              )}
            />
          </div>
        </Card>
      ) : (
        <Card
          title={TEXT.list}
          subtitle={`${hasFilter ? TEXT.filtered(rows.length, logs.length) : TEXT.total(logs.length)} · ${TEXT.expandHint}`}
        >
          <div className="logs-toolbar">
            <div className="logs-toolbar-row">
              <label className="logs-search">
                <IconSearch size={15} />
                <input
                  className="logs-search-input"
                  type="search"
                  value={filters.keyword}
                  placeholder={TEXT.keywordPlaceholder}
                  aria-label={TEXT.keywordLabel}
                  onChange={event => setFilters(current => ({ ...current, keyword: event.target.value }))}
                />
              </label>
              <div className="logs-chip-group" role="group" aria-label={TEXT.level} data-testid="logs-level-filter">
                {LEVEL_OPTIONS.map(option => (
                  <ChipButton
                    key={option.value}
                    tone={option.tone}
                    active={filters.levels.includes(option.value)}
                    title={`${option.label} ${levelCounts[option.value]} 条`}
                    onClick={() => toggleLevel(option.value)}
                  >
                    {option.label} {levelCounts[option.value]}
                  </ChipButton>
                ))}
              </div>
            </div>

            {sourcePool.length > 0 && (
              <div className="logs-toolbar-row">
                <span className="logs-chip-label">{TEXT.source}</span>
                <div className="logs-chip-group" role="group" aria-label={TEXT.source} data-testid="logs-source-filter">
                  {visibleSources.map(item => (
                    <ChipButton
                      key={item.value}
                      active={filters.source === item.value}
                      title={`#${item.value} ${item.count} 条`}
                      onClick={() => pickSource(item.value)}
                    >
                      #{item.value} {item.count}
                    </ChipButton>
                  ))}
                </div>
                {sourcePool.length > SOURCE_LIMIT && (
                  <button type="button" className="logs-plain" onClick={() => setAllSources(current => !current)}>
                    {allSources ? TEXT.lessSources : `${TEXT.moreSources} ${sourcePool.length}`}
                  </button>
                )}
              </div>
            )}
          </div>

          {hasFilter && (
            <div className="logs-cond" data-testid="logs-filter-bar">
              <span className="logs-cond-label">{TEXT.condLabel}</span>
              {filters.keyword.trim() !== '' && <Chip>{TEXT.keyword} {filters.keyword.trim()}</Chip>}
              {levels.map(level => <Chip key={level.value} tone={level.tone}>{level.label}</Chip>)}
              {filters.source !== '' && <Chip>#{filters.source}</Chip>}
              {(filters.from !== '' || filters.to !== '') && (
                <Chip>{TEXT.range} {filters.from === '' ? '…' : formatDay(filters.from)} – {filters.to === '' ? '…' : formatDay(filters.to)}</Chip>
              )}
              <span className="chip accent" data-testid="logs-hit-count">{TEXT.hits} {rows.length}</span>
              <button type="button" className="logs-plain" data-testid="logs-clear-filter" onClick={clearFilters}>
                {TEXT.clearFilter}
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <div data-testid="logs-filtered-empty">
              <Empty
                icon={<IconSearch size={20} />}
                title={TEXT.filteredEmpty}
                hint={TEXT.filteredEmptyHint}
                action={<button type="button" className="btn" onClick={clearFilters}>{TEXT.clearFilter}</button>}
              />
            </div>
          ) : (
            <div className="table logs-table" data-testid="logs-list">
              <div className="table-head">
                <span className="logs-bar-head" aria-hidden="true" />
                <span>{TEXT.time}</span>
                <span>{TEXT.source}</span>
                <span>{TEXT.content}</span>
                <span className="sr-only">{TEXT.actions}</span>
              </div>

              {groups.map(group => (
                <Fragment key={group.key}>
                  <div className="logs-group-head" data-testid="logs-group">
                    <span className="logs-group-label">{groupLabel(group.key, today)}</span>
                    {isRecent(group.key, today) && (
                      <span className="logs-group-date">{formatDay(group.key, 'full')}</span>
                    )}
                    <span className="logs-group-count">{group.items.length}</span>
                  </div>

                  {group.items.map((log, index) => {
                    const level = levelOf(log.level)
                    const tags = Array.isArray(log.tags) ? log.tags : []
                    const source = String(log.source ?? '').trim()
                    const time = formatTime(log.createdAt)
                    const isToday = group.key === today
                    const expanded = openId === log.id
                    const stamp = stampText(log.createdAt)
                    // 组尾行去掉实线，分组之间只留组头那条虚线。
                    const groupEnd = index === group.items.length - 1

                    return (
                      <div
                        className={`table-row logs-row ${expanded ? 'is-open' : ''} ${groupEnd ? 'is-group-end' : ''}`}
                        data-testid="log-row"
                        data-level={level.value}
                        data-date={group.key}
                        key={log.id}
                      >
                        <span className="logs-bar-cell">
                          <span className={`logs-bar ${level.value}`} aria-hidden="true" />
                          <span className="sr-only">{level.label}</span>
                        </span>

                        <time className="logs-time" dateTime={typeof log.createdAt === 'string' ? log.createdAt : undefined}>
                          {isToday && time !== ''
                            ? <span className="logs-time-hm">{time}</span>
                            : <span className="logs-time-day">{isToday ? '今天' : formatDay(group.key)}</span>}
                          {isToday === false && time !== '' && <span className="logs-time-hm">{time}</span>}
                        </time>

                        <span className="logs-source">
                          {source === '' ? <span className="logs-muted">{TEXT.noSource}</span> : (
                            <Chip><span className="logs-source-text">#{source}</span></Chip>
                          )}
                        </span>

                        <div className="logs-text">
                          <button
                            type="button"
                            className="logs-text-btn"
                            aria-expanded={expanded}
                            title={expanded ? TEXT.collapse : TEXT.expand}
                            onClick={() => setOpenId(current => (current === log.id ? null : log.id))}
                          >
                            <span className="logs-text-body">{log.text}</span>
                            <IconChevronRight className="logs-text-caret" size={14} />
                          </button>
                          {expanded && (
                            <div className="logs-detail" data-testid="log-detail">
                              <Chip tone={level.tone}>{level.label}</Chip>
                              {tags.map(tag => <Chip key={tag}>#{tag}</Chip>)}
                              {stamp !== '' && <span className="logs-detail-stamp">{TEXT.recordedAt} {stamp}</span>}
                            </div>
                          )}
                        </div>

                        <span className="logs-actions">
                          <IconButton
                            label={`${TEXT.delete}「${String(log.text ?? '').slice(0, 12)}」`}
                            tone="danger"
                            onClick={() => setPendingDelete(log)}
                          >
                            <IconTrash size={15} />
                          </IconButton>
                        </span>
                      </div>
                    )
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
