import { Markdown } from '@lobehub/ui'

/**
 * 右侧 AI 面板的正文渲染：与 /chat 正文同一套 @lobehub/ui Markdown
 * （src/components/MessageItem.tsx:101、:222：variant="chat"、fontSize=14、
 * fullFeaturedCodeBlock），用户消息与助手消息的文本都过它。
 *
 * 不传 enableStream：流式门槛是 `enableStream && delayedAnimated`
 * （node_modules/@lobehub/ui/es/Markdown/Markdown.mjs:64），MessageItem.tsx:222
 * 只传了 enableStream 没传 animated，delayedAnimated 恒为 undefined，
 * /chat 走的也是普通渲染；这里不加，行为与它一致。
 *
 * 外层 div.chat-md 让代码块全宽可滚动（样式由样式阶段提供），
 * 其 white-space:normal 还会盖掉 .bubble 继承来的 pre-wrap。
 * @param props - `text` 为消息正文，`fontSize` 默认与 /chat 一致（14）。
 * @returns 正文元素；空文本返回 null，免得渲染出空容器。
 */
export default function AssistantMarkdown({ text, fontSize = 14 }) {
  const body = String(text ?? '')
  if (body.trim() === '') return null
  return (
    <div className="chat-md" data-testid="chat-markdown">
      <Markdown variant="chat" fontSize={fontSize} fullFeaturedCodeBlock>{body}</Markdown>
    </div>
  )
}
