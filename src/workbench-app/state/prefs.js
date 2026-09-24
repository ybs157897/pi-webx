/**
 * 界面偏好：主题（auto/light/dark）、密度、AI 面板默认开合、各模块视图。
 * 持久化在服务端 workbench_meta（ui_prefs），与记录同库；本地先应用，写失败不回滚——
 * 偏好丢了只是一次不便，不应打断操作。挂在 <html> 的 data-theme / data-density 上，
 * SSR 环境（无 document）时静默跳过，模块测试不受影响。
 * @module state/prefs
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.mjs'

/** 把偏好落到 <html> 属性上。`auto` 跟随系统暗色。 */
export function applyPrefs(prefs) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  let theme = typeof prefs?.theme === 'string' ? prefs.theme : 'auto'
  if (theme === 'auto') {
    const dark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    theme = dark ? 'dark' : 'light'
  }
  root.dataset.theme = theme
  root.dataset.density = prefs?.density === 'compact' ? 'compact' : 'comfortable'
}

/**
 * 偏好状态 hook。
 * @param initial - 首帧从 /api/state 拿到的 prefs（SSR / 首屏渲染前的兜底）。
 * @returns `[prefs, setPref, replacePrefs]`：setPref(key, value) 乐观更新并异步落库；
 *   replacePrefs(whole) 用于启动时把服务端偏好整份灌入（不触发逐个写回）。
 */
export function usePrefs(initial = {}) {
  const [prefs, setPrefs] = useState(initial ?? {})

  const setPref = useCallback(async (key, value) => {
    let next = {}
    setPrefs((current) => {
      next = { ...current, [key]: value }
      applyPrefs(next)
      return next
    })
    try {
      const saved = await api.setPrefs({ [key]: value })
      setPrefs(saved)
      applyPrefs(saved)
    } catch {
      // 落库失败保留本地值即可。
    }
  }, [])

  const replacePrefs = useCallback((whole) => {
    const next = whole ?? {}
    setPrefs(next)
    applyPrefs(next)
  }, [])

  // auto 主题下跟随系统切换。
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const list = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => { if ((prefs?.theme ?? 'auto') === 'auto') applyPrefs(prefs) }
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [prefs])

  return [prefs, setPref, replacePrefs]
}
