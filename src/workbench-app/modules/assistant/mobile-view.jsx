/**
 * 移动端「事项 / 对话」两态的跨组件通道。
 *
 * 对话列是 App 以节点形式注入 workspace 的（`chat={<AssistantChat/>}`），节点在 App 里创建、
 * 拿不到 workspace 的视图 state；方案确认细条又必须留在对话列里才知道「这个会话有几份待确认」。
 * 用 context 补这一跳：context 在渲染期按元素树解析，与元素在哪创建无关。
 * 不在 workspace 内渲染时（例如未来的独立复用）退化为无操作。
 * @module modules/assistant/mobile-view
 */

import { createContext, useContext } from 'react'

const FALLBACK = { showChat: () => {} }

export const AssistantMobileView = createContext(FALLBACK)

/** 读移动端切换口：`showChat()` 让事项视图切回对话视图。 */
export function useAssistantMobileView() {
  return useContext(AssistantMobileView) ?? FALLBACK
}
