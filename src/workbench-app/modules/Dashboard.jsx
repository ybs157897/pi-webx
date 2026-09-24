/**
 * 我的主页：问候 + 今日任务。
 *
 * 模块统一 props（各模块组件一致，定义见 App.jsx）：
 * `data` /api/state 的 data（结构已在 App 归一化）；`profile` 顶层 profile；
 * `mutate(action, okText)` 写操作 + 刷新 + 反馈；`refresh()` 只重新拉数据；
 * `notify(text, tone)` 轻提示；`navigate(moduleId)` 切模块。
 * @module src/modules/Dashboard
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Empty } from '../ui.jsx'
import { ProgressRing } from '../charts.jsx'
import { IconCalendar, IconCheck, IconTasks } from '../icons.jsx'
import { formatDay, greeting, todayISO } from '../util.mjs'

const TEXT = {
  tasks: '今日任务',
  tasksHint: '今天到期，以及没排期的待办',
  allTasks: '全部任务',
  planIt: '去安排',
  planEmpty: '今天没有待办，去规划页安排一件小事吧',
  tasksDone: '今日完成',
  rest: '条在列表里',
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 }

/** 主页所需的全部派生数据（都从 /api/state 前端算，不额外请求）。 */
function useOverview(data) {
  return useMemo(() => {
    const today = todayISO()
    const todayTasks = data.tasks.filter(task => task.due === today || (task.due === null && !task.done))
    const sorted = [...todayTasks].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    })

    return {
      today,
      taskList: sorted.slice(0, 5),
      taskRest: Math.max(0, sorted.length - 5),
      taskDone: sorted.filter(task => task.done).length,
      taskTotal: sorted.length,
    }
  }, [data])
}

export default function Dashboard({ data, profile, navigate, mutate }) {
  const [pendingId, setPendingId] = useState('')
  const view = useOverview(data)

  /** 勾选完成/取消：主页也能一键打钩，操作后 App 统一刷新。 */
  async function toggleTask(task) {
    setPendingId(task.id)
    await mutate(() => api.patchRecord('tasks', task.id, { done: task.done !== true }))
    setPendingId('')
  }

  return (
    <>
      <section className="card hero">
        <div>
          <h2 className="hero-greet">{greeting()}，{profile.name}</h2>
          <p className="hero-date">{formatDay(view.today, 'full')}</p>
          {profile.motto !== '' && <p className="hero-motto">「{profile.motto}」</p>}
        </div>
        <div className="hero-side">
          <ProgressRing
            value={view.taskDone}
            max={view.taskTotal}
            size={112}
            label={`${TEXT.tasksDone} ${view.taskDone}/${view.taskTotal}`}
          />
        </div>
      </section>

      <Card
        title={TEXT.tasks}
        subtitle={TEXT.tasksHint}
        action={<button type="button" className="btn btn-sm" onClick={() => navigate('tasks')}>{TEXT.allTasks}</button>}
      >
        {view.taskList.length === 0
          ? (
            <Empty
              icon={<IconTasks size={22} />}
              title={TEXT.planEmpty}
              action={<button type="button" className="btn btn-sm btn-primary" onClick={() => navigate('tasks')}>{TEXT.planIt}</button>}
            />
          )
          : (
            <ul className="list">
              {view.taskList.map(task => (
                <li className="list-item" key={task.id}>
                  <input
                    type="checkbox"
                    className="check"
                    checked={task.done === true}
                    disabled={pendingId === task.id}
                    aria-label={task.done === true ? `取消完成：${task.title}` : `完成：${task.title}`}
                    onChange={() => toggleTask(task)}
                  />
                  <div className="item-main">
                    <p className={`item-title ${task.done === true ? 'is-done' : ''}`}>{task.title}</p>
                    <div className="item-meta">
                      {task.priority === 'high' && <span>高优先级</span>}
                      {task.priority === 'low' && <span>低优先级</span>}
                      {task.tag !== '' && <span>#{task.tag}</span>}
                      {task.due !== null && <span><IconCalendar size={12} /> {formatDay(task.due)}</span>}
                    </div>
                  </div>
                  {task.done === true && <span className="item-actions always muted" aria-hidden="true"><IconCheck size={15} /></span>}
                </li>
              ))}
            </ul>
          )}
        {view.taskRest > 0 && (
          <p className="small muted" style={{ marginTop: '10px' }}>还有 {view.taskRest} {TEXT.rest}，点「{TEXT.allTasks}」查看。</p>
        )}
      </Card>
    </>
  )
}
