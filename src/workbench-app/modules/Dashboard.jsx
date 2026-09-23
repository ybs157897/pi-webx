/**
 * 我的主页：问候 + 今日任务 + 各模块动态卡片。
 *
 * 模块统一 props（10 个模块组件一致，定义见 App.jsx）：
 * `data` /api/state 的 data（结构已在 App 归一化）；`profile` 顶层 profile；
 * `mutate(action, okText)` 写操作 + 刷新 + 反馈；`refresh()` 只重新拉数据；
 * `notify(text, tone)` 轻提示；`navigate(moduleId)` 切模块；
 * `modules` 菜单注册表（动态卡片按 id 取标签与图标）。
 * @module src/modules/Dashboard
 */

import { useMemo, useState } from 'react'
import { api } from '../api.mjs'
import { Card, Empty } from '../ui.jsx'
import { ProgressRing } from '../charts.jsx'
import { IconCalendar, IconCheck, IconTasks } from '../icons.jsx'
import { byDateDesc, formatDay, greeting, money, numberText, sumBy, todayISO } from '../util.mjs'

const TEXT = {
  tasks: '今日任务',
  tasksHint: '今天到期，以及没排期的待办',
  allTasks: '全部任务',
  planIt: '去安排',
  planEmpty: '今天没有待办，去规划页安排一件小事吧',
  dynamic: '各模块动态',
  dynamicHint: '点卡片进入对应模块',
  noRecord: '还没有记录',
  noReview: '今天还没写，去记一笔',
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
    const todayExercises = data.exercises.filter(row => row.date === today)
    const todayMeals = data.meals.filter(row => row.date === today)
    const month = today.slice(0, 7)
    const monthRows = data.finance.filter(row => row.date.slice(0, 7) === month)
    const income = sumBy(monthRows.filter(row => row.kind === 'income'), row => row.amount)
    const expense = sumBy(monthRows.filter(row => row.kind === 'expense'), row => row.amount)

    return {
      today,
      taskList: sorted.slice(0, 5),
      taskRest: Math.max(0, sorted.length - 5),
      taskDone: sorted.filter(task => task.done).length,
      taskTotal: sorted.length,
      minutes: sumBy(todayExercises, row => row.minutes),
      exerciseCount: todayExercises.length,
      calories: sumBy(todayMeals, row => row.calories),
      mealCount: todayMeals.length,
      balance: income - expense,
      monthCount: monthRows.length,
      latestPet: [...data.pets.records].sort(byDateDesc(row => row.date))[0],
      latestRelation: [...data.relationships.records].sort(byDateDesc(row => row.date))[0],
      todayReview: data.reviews.find(row => row.date === today),
    }
  }, [data])
}

export default function Dashboard({ data, profile, modules, navigate, mutate }) {
  const [pendingId, setPendingId] = useState('')
  const view = useOverview(data)

  /** 勾选完成/取消：主页也能一键打钩，操作后 App 统一刷新。 */
  async function toggleTask(task) {
    setPendingId(task.id)
    await mutate(() => api.patchRecord('tasks', task.id, { done: task.done !== true }))
    setPendingId('')
  }

  const cards = [
    {
      id: 'exercises',
      value: numberText(view.minutes),
      unit: '分钟',
      text: view.exerciseCount > 0 ? `今天打卡 ${view.exerciseCount} 次` : TEXT.noRecord,
    },
    {
      id: 'meals',
      value: numberText(view.calories),
      unit: 'kcal',
      text: view.mealCount > 0 ? `今天记录 ${view.mealCount} 餐` : TEXT.noRecord,
    },
    {
      id: 'finance',
      value: money(view.balance),
      unit: '',
      text: view.monthCount > 0 ? `本月 ${view.monthCount} 笔流水` : TEXT.noRecord,
    },
    {
      id: 'pets',
      value: view.latestPet === undefined ? '—' : view.latestPet.title,
      unit: '',
      text: view.latestPet === undefined ? TEXT.noRecord : formatDay(view.latestPet.date),
    },
    {
      id: 'relationships',
      value: view.latestRelation === undefined ? '—' : view.latestRelation.title,
      unit: '',
      text: view.latestRelation === undefined ? TEXT.noRecord : formatDay(view.latestRelation.date),
    },
    {
      id: 'reviews',
      value: view.todayReview === undefined ? '未记录' : `${view.todayReview.mood} / 5`,
      unit: '',
      text: view.todayReview === undefined ? TEXT.noReview : view.todayReview.wins,
    },
  ]

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

      <Card title={TEXT.dynamic} subtitle={TEXT.dynamicHint}>
        <div className="grid grid-3">
          {cards.map(card => {
            const meta = modules.find(module => module.id === card.id)
            if (meta === undefined) return null
            const Icon = meta.icon
            return (
              <button type="button" className="dyn-card" key={card.id} onClick={() => navigate(card.id)}>
                <span className="dyn-head"><Icon size={16} /> {meta.label}</span>
                <span className="dyn-value">
                  {card.value}
                  {card.unit !== '' && <em>{card.unit}</em>}
                </span>
                <span className="dyn-note">{card.text}</span>
              </button>
            )
          })}
        </div>
      </Card>
    </>
  )
}
