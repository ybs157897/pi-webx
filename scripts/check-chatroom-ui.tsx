import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Chatroom, { ChatroomIcon, ChatroomView, chatroomRefreshDelta } from '../src/workbench-app/modules/chatroom/index.jsx'
import ChatroomComposer from '../src/workbench-app/modules/chatroom/Composer.jsx'
import { mergeChatroomMessages, selectWatchedMessages } from '../src/workbench-app/modules/chatroom/useChatroom.js'

const message = (seq: number, patch: Record<string, unknown> = {}) => ({
  seq, id: `message-${seq}`, senderId: 'requirements', senderName: '需求管理',
  recipientId: 'assistant', body: `正文 ${seq}`, createdAt: `2026-09-29T08:0${seq}:00.000Z`,
  threadId: 'req-1', deliveryStatus: 'delivered',
  ...patch,
})
const consumption = (agentId: string, agentName: string, status: string, patch: Record<string, unknown> = {}) => ({
  agentId, agentName, status, startedAt: null, finishedAt: null, error: null, ...patch,
})
const members = [
  { id: 'requirements', name: '需求管理' },
  { id: 'assistant', name: '我的助理' },
  { id: 'codes', name: '代码研发' },
]
const render = (Component: any, props: Record<string, unknown> = {}) => renderToStaticMarkup(h(Component, props))

const html = render(ChatroomView, {
  room: { id: 'internal', name: '内部聊天室' }, members,
  messages: [message(3, { senderId: 'codes', senderName: '代码研发', recipientId: 'assistant', body: '研发完成，通知助理更新状态。', thinking: 'private rationale', toolCalls: ['bash'] }),
    message(1, { body: '已确认需求，请助理生成待办。\n接着找研发执行。' }),
    message(2, { senderId: 'assistant', senderName: '我的助理', recipientId: 'codes', body: '<script>只当正文</script>', deliveryStatus: 'running' })],
  unseenCount: 2,
})

assert.match(html, /data-testid="chatroom-workspace"/)
assert.match(html, /data-testid="chatroom-title">内部聊天室/)
assert.match(html, /data-testid="chatroom-members"/)
assert.equal((html.match(/data-testid="chatroom-message"/g) || []).length, 3)
assert.deepEqual([...html.matchAll(/data-seq="(\d+)"/g)].map(match => Number(match[1])), [1, 2, 3], '群消息必须按 seq 排序')
assert.match(html, /需求管理/)
assert.match(html, /我的助理/)
assert.match(html, /代码研发/)
assert.match(html, /已确认需求，请助理生成待办。\n接着找研发执行。/)
assert.match(html, /&lt;script&gt;只当正文&lt;\/script&gt;/, '正文只能按纯文本转义渲染')
assert.doesNotMatch(html, /private rationale|toolCalls|bash/, '思考与工具数据不得进入群聊 DOM')
assert.match(html, /data-testid="chatroom-delivery"[^>]*>处理中/)
const broadcastPending = render(ChatroomView, {
  room: { id: 'internal', name: '内部聊天室' }, members,
  messages: [message(1, { senderId: 'user', senderName: '我', recipientId: null, body: '帮我处理这件事。', deliveryStatus: 'pending' })],
})
assert.match(broadcastPending, /data-testid="chatroom-delivery"[^>]*>等待认领/, '用户未点名消息展示等待认领状态')
const addressedPending = render(ChatroomView, {
  room: { id: 'internal', name: '内部聊天室' }, members,
  messages: [message(1, { senderId: 'user', senderName: '我', recipientId: 'requirements', body: '@需求管理 处理这件事。', deliveryStatus: 'pending' })],
})
assert.match(addressedPending, /data-testid="chatroom-delivery"[^>]*>待接收/)
const consumerStates = render(ChatroomView, {
  members,
  messages: [
    message(1, { senderId: 'user', senderName: '我', recipientId: null, deliveryStatus: 'delivered', consumptions: [
      consumption('requirements', '需求管理', 'skipped'),
      consumption('codes', '代码研发', 'consumed', { finishedAt: '2026-09-29T08:01:00.000Z' }),
      consumption('logs', '日志查询', 'failed', { error: '<script>公开错误</script>' }),
      consumption('assistant', '我的助理', 'evaluating'),
    ] }),
    message(2, { consumptions: [consumption('requirements', '需求管理', 'pending')] }),
    message(3, { consumptions: [consumption('codes', '代码研发', 'processing')] }),
  ],
})
assert.equal((consumerStates.match(/data-testid="chatroom-consumptions"/g) || []).length, 3)
assert.equal((consumerStates.match(/data-testid="chatroom-consumption"/g) || []).length, 6)
for (const [agentId, status] of [['requirements', 'skipped'], ['codes', 'consumed'], ['logs', 'failed'], ['assistant', 'evaluating']]) {
  assert.match(consumerStates, new RegExp(`data-testid="chatroom-consumption" data-agent-id="${agentId}" data-status="${status}"`))
}
for (const label of ['未认领', '已消费并回复', '消费失败', '判断中', '待接收', '处理中'])
  assert.match(consumerStates, new RegExp(label))
assert.match(consumerStates, /&lt;script&gt;公开错误&lt;\/script&gt;/, '消费失败原因只能按纯文本渲染')
assert.doesNotMatch(consumerStates, /<script>公开错误<\/script>/)
assert.match(html, /data-testid="chatroom-jump-latest"/)
assert.match(html, /data-testid="chatroom-composer"/)
assert.match(html, /data-testid="chatroom-at-button"/)
assert.match(html, /data-testid="chatroom-input"/)
assert.match(html, /data-testid="chatroom-send"/)
assert.equal((html.match(/data-testid="chatroom-reply"/g) || []).length, 3, '每条 Agent 消息都应能回复')

const ownReply = render(ChatroomView, { members: [...members, { id: 'user', name: '我' }], messages: [
  message(1), message(2, { id: 'user-reply', senderId: 'user', senderName: '我', recipientId: 'requirements', replyTo: 'message-1', body: '@需求管理 这是补充说明。' }),
] })
assert.match(ownReply, /class="chatroom-entry is-self"/)
assert.match(ownReply, /data-testid="chatroom-reply-quote"/)
assert.match(ownReply, /class="chatroom-body-mention">@需求管理/)
assert.equal((ownReply.match(/data-testid="chatroom-reply"/g) || []).length, 1, '自己的消息不应再显示回复按钮')

const composing = render(ChatroomComposer, {
  members, body: '@需', mentionOpen: true, mentionOptions: [{ id: 'requirements', name: '需求管理' }],
  replyingTo: message(1), sendError: '上一条消息未确认送达', canRetrySend: true,
})
for (const id of ['chatroom-mention-menu', 'chatroom-mention-option', 'chatroom-reply-target', 'chatroom-cancel-reply', 'chatroom-send-error', 'chatroom-send-retry'])
  assert.match(composing, new RegExp(`data-testid="${id}"`), `输入区缺 ${id}`)
assert.match(composing, /aria-activedescendant="chatroom-mention-requirements"/, '输入区应声明当前键盘选择')
const beforeSync = render(ChatroomComposer, { body: '@需求管理 请澄清' })
assert.match(beforeSync, /<button[^>]*type="submit"[^>]*disabled=""[^>]*data-testid="chatroom-send"/, '首次 GET 尚未获取成员时不得发送')

const updated = mergeChatroomMessages([message(1), message(2, { deliveryStatus: 'running' })], [
  message(3), message(2, { deliveryStatus: 'delivered' }),
])
assert.deepEqual(updated.map(row => row.seq), [1, 2, 3])
assert.equal(updated[1].deliveryStatus, 'delivered', '旧消息终态更新必须覆盖先前状态')
assert.equal(mergeChatroomMessages(updated, [message(2, { deliveryStatus: 'delivered' })]), updated, '无内容变化时不触发界面重复刷新')
const beforeConsumption = message(4, { consumptions: [consumption('codes', '代码研发', 'processing')] })
const afterConsumption = message(4, { consumptions: [consumption('codes', '代码研发', 'consumed')] })
const consumptionUpdated = mergeChatroomMessages([beforeConsumption], [afterConsumption])
assert.equal(consumptionUpdated[0]?.consumptions[0]?.status, 'consumed', '只变更成员消费状态也必须刷新消息')
assert.equal(mergeChatroomMessages(consumptionUpdated, [message(4, { consumptions: [consumption('codes', '代码研发', 'consumed')] })]), consumptionUpdated, '相同消费记录不重复刷新')
const watchable = Array.from({ length: 230 }, (_, index) => message(index + 1, { deliveryStatus: 'running' }))
assert.deepEqual(selectWatchedMessages(watchable, 0).map(row => row), Array.from({ length: 100 }, (_, index) => index + 1))
assert.deepEqual(selectWatchedMessages(watchable, 100).map(row => row), Array.from({ length: 100 }, (_, index) => index + 101))
assert.deepEqual(selectWatchedMessages(watchable, 200).map(row => row), [...Array.from({ length: 30 }, (_, index) => index + 201), ...Array.from({ length: 70 }, (_, index) => index + 1)])
assert.deepEqual(selectWatchedMessages(watchable.slice(0, 3), 0), [1, 2, 3], '不足100条 watch 时不应重复')
assert.deepEqual(selectWatchedMessages([message(1, { deliveryStatus: 'delivered', consumptions: [consumption('codes', '代码研发', 'processing')] })], 0), [1], '整体状态已结束但成员仍处理中时继续 watch')
assert.deepEqual(selectWatchedMessages([message(1, { deliveryStatus: 'delivered', consumptions: [consumption('codes', '代码研发', 'consumed')] })], 0), [], '成员消费结束后停止 watch')

const inProgress = message(9, { deliveryStatus: 'running', consumptions: [consumption('codes', '代码研发', 'processing')] })
const initialRefresh = chatroomRefreshDelta(new Map(), [inProgress])
assert.equal(initialRefresh.changed, true, '新消息仍刷新工作台数据')
assert.equal(chatroomRefreshDelta(initialRefresh.next, [{ ...inProgress }]).changed, false, '相同进度不重复刷新')
const firstConsumed = message(9, { deliveryStatus: 'running', consumptions: [consumption('codes', '代码研发', 'consumed')] })
const consumedRefresh = chatroomRefreshDelta(initialRefresh.next, [firstConsumed])
assert.equal(consumedRefresh.changed, true, '一位成员消费完成即刷新工作台数据')
assert.equal(chatroomRefreshDelta(consumedRefresh.next, [message(9, {
  deliveryStatus: 'running', consumptions: [consumption('codes', '代码研发', 'consumed', { finishedAt: '2026-09-29T08:01:00.000Z' })],
})]).changed, false, '同一成员同一终态只刷新一次')
const anotherFailed = message(9, { deliveryStatus: 'running', consumptions: [
  consumption('codes', '代码研发', 'consumed'), consumption('logs', '日志查询', 'failed'),
] })
assert.equal(chatroomRefreshDelta(consumedRefresh.next, [anotherFailed]).changed, true, '另一成员消费失败也刷新工作台数据')
assert.equal(chatroomRefreshDelta(consumedRefresh.next, [message(9, {
  deliveryStatus: 'delivered', consumptions: [consumption('codes', '代码研发', 'consumed')],
})]).changed, true, '整体投递终态仍刷新工作台数据')

const empty = render(ChatroomView, { members, messages: [], syncStatus: 'online' })
assert.match(empty, /data-testid="chatroom-empty"/)
assert.match(empty, /自行认领/)
const failed = render(ChatroomView, { messages: [message(1, { deliveryStatus: 'failed', error: '超时' })], syncStatus: 'error', error: '聊天记录暂时无法同步，请重试。' })
assert.match(failed, /data-testid="chatroom-error"/)
assert.match(failed, /data-testid="chatroom-retry"/)
assert.match(failed, /data-testid="chatroom-delivery"[^>]*>投递失败：超时/)
const unclaimed = render(ChatroomView, { messages: [message(1, {
  deliveryStatus: 'failed', error: '没有成员认领这条广播；可 @指定成员后重发', consumptions: [
    consumption('requirements', '需求管理', 'skipped'), consumption('codes', '代码研发', 'skipped'),
  ],
})] })
assert.match(unclaimed, /data-testid="chatroom-delivery"[^>]*>无人认领：没有成员认领这条广播/)
assert.equal((unclaimed.match(/data-testid="chatroom-consumption"/g) || []).length, 2, '未认领成员仍应逐个显示')
assert.match(render(ChatroomIcon), /<svg[^>]*aria-hidden="true"/)
assert.match(render(Chatroom), /data-testid="chatroom-workspace"/, '页面默认导出须可在 SSR 中无浏览器对象渲染')

console.log('chatroom UI: chronological text-only messages, status updates and empty/error states passed')
