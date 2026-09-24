/**
 * 命令面板（⌘K）：全局搜索（服务端 /search）+ 模块跳转 + 快捷操作。
 * 键盘：↑↓ 选择、Enter 执行、Esc 关闭。输入防抖 120ms，搜索期间不阻塞键盘。
 * @module shell/CommandPalette
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.mjs'
import { IconCommand, IconMoon, IconSearch, IconSettings, IconSparkles } from '../icons.jsx'

const MODULE_ACTIONS_LIMIT = 7

export default function CommandPalette({ modules, onNavigate, onOpenSettings, onToggleTheme, theme, onClose }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState([])
  const [active, setActive] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 输入防抖：停手 120ms 才发请求。
  useEffect(() => {
    const q = query.trim()
    if (q === '') { setHits([]); return undefined }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await api.search(q)
        if (!cancelled) setHits(result.results ?? [])
      } catch {
        if (!cancelled) setHits([])
      }
    }, 120)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query])

  const groups = useMemo(() => {
    const list = []
    const q = query.trim()
    const moduleMatched = modules.filter(module => q === '' || module.label.includes(q) || module.desc.includes(q))
    if (q !== '' && hits.length > 0) {
      list.push({
        title: '记录',
        items: hits.map(hit => {
          const module = modules.find(item => item.id === hit.module)
          return {
            key: `hit-${hit.module}-${hit.id}`,
            icon: module?.icon ?? IconSearch,
            title: hit.title,
            sub: `${module?.label ?? hit.module} · ${hit.snippet || '无摘要'}`,
            run: () => onNavigate(hit.module),
          }
        }),
      })
    }
    if (moduleMatched.length > 0) {
      list.push({
        title: q === '' ? '跳转' : '模块',
        items: moduleMatched.slice(0, MODULE_ACTIONS_LIMIT).map(module => ({
          key: `module-${module.id}`,
          icon: module.icon,
          title: module.label,
          sub: module.desc,
          run: () => onNavigate(module.id),
        })),
      })
    }
    const themeWanted = q === '' || '切换主题'.includes(q) || '暗色'.includes(q) || '亮色'.includes(q)
    const settingsWanted = q === '' || '设置'.includes(q) || '数据'.includes(q)
    const actions = []
    if (themeWanted) {
      actions.push({
        key: 'action-theme',
        icon: theme === 'dark' ? IconSparkles : IconMoon,
        title: theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题',
        sub: '也可以在设置里改成跟随系统',
        run: onToggleTheme,
      })
    }
    if (settingsWanted) {
      actions.push({
        key: 'action-settings',
        icon: IconSettings,
        title: '打开设置',
        sub: '外观、数据管理与快捷键',
        run: onOpenSettings,
      })
    }
    if (actions.length > 0) list.push({ title: '操作', items: actions })
    return list
  }, [hits, modules, onNavigate, onOpenSettings, onToggleTheme, query, theme])

  const flat = useMemo(() => groups.flatMap(group => group.items), [groups])
  const total = flat.length

  useEffect(() => {
    if (active >= total) setActive(0)
  }, [active, total])

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => (total === 0 ? 0 : (current + 1) % total))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => (total === 0 ? 0 : (current - 1 + total) % total))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const item = flat[active]
      if (item !== undefined) {
        item.run()
        onClose()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  let index = -1

  return (
    <div
      className="palette-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-input-row">
          <IconCommand size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="搜索记录、跳转模块、执行命令…"
            aria-label="命令面板输入"
            onChange={event => { setQuery(event.target.value); setActive(0) }}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list">
          {total === 0 && query.trim() !== '' && <p className="palette-empty">没有匹配「{query.trim()}」的记录或命令</p>}
          {groups.map(group => (
            <div key={group.title}>
              <p className="palette-group">{group.title}</p>
              {group.items.map(item => {
                index += 1
                const Icon = item.icon
                const isActive = index === active
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={`palette-item ${isActive ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => { item.run(); onClose() }}
                  >
                    <span className="palette-item-icon"><Icon size={14} /></span>
                    <span className="palette-item-text grow">
                      <span className="palette-item-title ellipsis">{item.title}</span>
                      {item.sub !== '' && <span className="palette-item-sub ellipsis" style={{ display: 'block' }}>{item.sub}</span>}
                    </span>
                    {isActive && <kbd>↵</kbd>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 执行</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>
  )
}
