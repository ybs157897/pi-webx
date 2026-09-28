/**
 * 我的主页：指挥台 widget 板（多列 widget 形态，参考 glanceapp/glance 的主页）。
 *
 * 栅格：CSS Grid 自适应列（宽屏三列 / 中屏两列 / 手机单列），每格一张 Card——
 * 问候 + AI 早报、今日进度环、今日待办、问题速览、最近日志、开发事项；
 * 空库（`empty` 且没有任何记录）时整块换成首启引导卡（灌入演示数据 / 先去规划今天）。
 *
 * 数据纪律：所有数字都在渲染期从 `data` 现算（`deskOverview`），模块内不存第二份记录；
 * 写操作一律 `mutate(action, okText)` 交给 App 重新拉 state。
 * props 契约见 App.jsx（`data`/`profile`/`mutate`/`navigate`/`empty`/`onLoadDemo`）。
 * @module src/workbench-app/modules/dashboard
 */

import { useMemo, useState } from 'react'
import { api } from '../../api.mjs'
import { Card, Chip, Empty, IconButton } from '../../ui.jsx'
import { IconCheck, IconPlus, IconSparkles, IconTasks } from '../../icons.jsx'
import { formatDay, greeting, relativeDay } from '../../util.mjs'
import './Dashboard.css'

import {
  TEXT,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  LEVEL_LABEL,
  LEVEL_TONE,
  priorityOf,
  levelOf,
  titleOf,
  deskOverview,
  briefOf,
  ProgressRing
} from './model.jsx'

export default function Dashboard({ data, profile, mutate, navigate, empty, onLoadDemo }) {
  const [pendingId, setPendingId] = useState('')
  const [demoBusy, setDemoBusy] = useState(false)
  const view = useMemo(() => deskOverview(data), [data])
  const name = String(profile?.name ?? '').trim() === '' ? '我' : String(profile.name).trim()
  const motto = String(profile?.motto ?? '').trim()

  /** 主页勾选即完成：写完由 App 统一刷新，失败会弹提示（不做乐观更新，避免两份状态）。 */
  async function toggleTask(task) {
    setPendingId(task.id)
    await mutate(() => api.patchRecord('tasks', task.id, { done: true }), TEXT.taskDone)
    setPendingId('')
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  // 首启（库为空）：整块换成引导卡，不摆一排空 widget。
  if (empty === true && view.totalRecords === 0) {
    return (
      <div className="dash" data-module="dashboard">
        <div className="dash-grid">
          <div className="dash-cell dash-cell-wide dash-cell-guide" data-widget="welcome">
            <Card>
              <div className="dash-guide">
                <span className="dash-guide-icon"><IconSparkles size={22} /></span>
                <h2 className="dash-guide-title">{TEXT.guideTitle}</h2>
                <p className="dash-guide-text">{TEXT.guideText}</p>
                <div className="dash-guide-actions">
                  {typeof onLoadDemo === 'function' && (
                    <button type="button" className="btn btn-primary" disabled={demoBusy} onClick={loadDemo}>
                      {demoBusy ? '正在灌入…' : TEXT.guideDemo}
                    </button>
                  )}
                  <button type="button" className="btn" onClick={() => navigate('tasks')}>{TEXT.guidePlan}</button>
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dash" data-module="dashboard">
      <div className="dash-grid">
        <div className="dash-cell dash-cell-wide" data-widget="greeting">
          <Card>
            <div className="dash-greet">
              <div className="dash-greet-main">
                <h2 className="dash-greet-title">{greeting()}，{name}</h2>
                <p className="dash-greet-date">{formatDay(view.today, 'full')}</p>
                {motto !== '' && <p className="dash-greet-motto">「{motto}」</p>}
              </div>
              <div className="dash-brief">
                <p className="dash-brief-label"><IconSparkles size={14} />{TEXT.brief}</p>
                <p className="dash-brief-text">{briefOf(view)}</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="progress">
          <Card
            title={TEXT.progress}
            subtitle={TEXT.progressHint}
            action={<IconButton label={TEXT.plan} onClick={() => navigate('tasks')}><IconTasks size={16} /></IconButton>}
          >
            <div className="dash-progress">
              <ProgressRing done={view.todayDone} total={view.todayTotal} />
              <div className="dash-progress-side">
                <p className="dash-progress-value">{view.todayDone}<span className="dash-progress-total">/{view.todayTotal}</span></p>
                <p className="dash-progress-label">{TEXT.progressLabel}</p>
              </div>
            </div>
            <div className="dash-foot">
              <span>{TEXT.dueToday} {view.dueToday} 项</span>
              {view.overdue > 0 && <Chip tone="danger">{TEXT.overdue} {view.overdue} 项</Chip>}
              {view.todayTotal === 0 && <span>{TEXT.noPlan}</span>}
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="todos">
          <Card
            title={TEXT.todos}
            subtitle={TEXT.todosHint}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('tasks')}>{TEXT.viewAll}</button>}
          >
            {view.queue.length === 0
              ? <Empty icon={<IconCheck size={20} />} title={TEXT.todosEmpty} hint={TEXT.todosEmptyHint} />
              : (
                <ul className="dash-list">
                  {view.queue.slice(0, 5).map(task => (
                    <li className="dash-todo" key={task.id}>
                      <input
                        type="checkbox"
                        className="dash-check"
                        checked={false}
                        disabled={pendingId === task.id}
                        aria-label={`完成：${titleOf(task)}`}
                        onChange={() => toggleTask(task)}
                      />
                      <div className="dash-todo-main">
                        <p className="dash-todo-title">{titleOf(task)}</p>
                        <p className="dash-todo-meta">
                          {typeof task.due === 'string' && (
                            <span className={`dash-due ${task.due < view.today ? 'is-overdue' : ''}`}>
                              {relativeDay(task.due, view.today)}
                            </span>
                          )}
                          <Chip tone={PRIORITY_TONE[priorityOf(task.priority)]}>{PRIORITY_LABEL[priorityOf(task.priority)]}</Chip>
                          {typeof task.tag === 'string' && task.tag !== '' && <span className="dash-tag">#{task.tag}</span>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            {view.queue.length > 5 && (
              <p className="dash-none">{TEXT.restPrefix} {view.queue.length - 5} {TEXT.restSuffix}</p>
            )}
          </Card>
        </div>

        <div className="dash-cell" data-widget="fixes">
          <Card
            title={TEXT.fixes}
            subtitle={TEXT.fixesHint}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('fixes')}>{TEXT.fixGo}</button>}
          >
            <div className="dash-figures">
              <div className="dash-figure">
                <span className="dash-figure-value">{view.fixTodo}</span>
                <span className="dash-figure-label">{TEXT.fixTodo}</span>
              </div>
              <div className="dash-figure is-accent">
                <span className="dash-figure-value">{view.fixDoing}</span>
                <span className="dash-figure-label">{TEXT.fixDoing}</span>
              </div>
              <div className="dash-figure is-ok">
                <span className="dash-figure-value">{view.fixDone}</span>
                <span className="dash-figure-label">{TEXT.fixDone}</span>
              </div>
            </div>
            <div className="dash-foot">
              {view.fixHigh > 0
                ? <Chip tone="danger">{TEXT.fixHigh} {view.fixHigh}</Chip>
                : <Chip tone="ok">{TEXT.fixClear}</Chip>}
              <span>{view.fixOpen > 0 ? `${TEXT.open} ${view.fixOpen} 个` : TEXT.fixEmpty}</span>
            </div>
          </Card>
        </div>

        <div className="dash-cell" data-widget="logs">
          <Card
            title={TEXT.logs}
            subtitle={TEXT.logsHint}
            action={(
              <button type="button" className="btn btn-sm" onClick={() => navigate('logs')}>
                <IconPlus size={13} />
                {TEXT.record}
              </button>
            )}
          >
            {view.logs.length === 0
              ? <p className="dash-none">{TEXT.logsEmpty}</p>
              : (
                <ul className="dash-list">
                  {view.logs.map(log => (
                    <li className="dash-log" key={log.id}>
                      <p className="dash-log-head">
                        <Chip tone={LEVEL_TONE[levelOf(log.level)]}>{LEVEL_LABEL[levelOf(log.level)]}</Chip>
                        <span className="dash-log-date">{formatDay(log.date)}</span>
                        {typeof log.source === 'string' && log.source !== '' && (
                          <span className="dash-log-source">{log.source}</span>
                        )}
                      </p>
                      <p className="dash-log-text">{log.text}</p>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>

        <div className="dash-cell" data-widget="codes">
          <Card
            title={TEXT.codes}
            subtitle={view.codeTotal === 0 ? TEXT.codesHintEmpty : `${TEXT.open} ${view.codeOpen} / ${TEXT.codeTotal} ${view.codeTotal}`}
            action={<button type="button" className="btn btn-sm" onClick={() => navigate('codes')}>{TEXT.codesGo}</button>}
          >
            {view.codeRows.length === 0
              ? <p className="dash-none">{TEXT.codesHintEmpty}</p>
              : (
                <ul className="dash-list">
                  {view.codeRows.map(row => (
                    <li className="dash-code" key={row.project}>
                      <p className="dash-code-head">
                        <span className="dash-code-name">{row.project}</span>
                        <span className="dash-code-count">{row.open}/{row.total}</span>
                      </p>
                      <span className="dash-bar" aria-hidden="true">
                        <span style={{ width: `${row.total === 0 ? 0 : Math.round(((row.total - row.open) / row.total) * 100)}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>
      </div>
    </div>
  )
}
