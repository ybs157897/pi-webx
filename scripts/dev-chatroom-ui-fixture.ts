/**
 * Isolated HTTP fixture for checking the real workbench chatroom view in a browser.
 * Start API: ./node_modules/.bin/tsx scripts/dev-chatroom-ui-fixture.ts
 * Start UI:  PI_WEBX_PORT=18887 ./node_modules/.bin/vite --host 127.0.0.1 --port 5189 --strictPort
 */
import express from 'express'
import { parseChatroomMentions } from '../src/shared/chatroom-mentions.mjs'

const app = express()
app.use(express.json())
const port = Number(process.env.PI_WEBX_CHATROOM_UI_FIXTURE_PORT ?? 18887)
let phase = 0
let failing = false
let requests = 0
let sendFailure: 'none' | 'before' | 'after' = 'none'
let sendDelayMs = 0
let nextSeq = 5
const byEntryKey = new Map<string, ReturnType<typeof make>>()

const members = [
  { id: 'requirements', name: '需求管理' },
  { id: 'assistant', name: '我的助理' },
  { id: 'codes', name: '代码开发' },
  { id: 'logs', name: '日志查询' },
  { id: 'user', name: '我' },
]
const make = (seq: number, senderId: string, recipientId: string | null, body: string, deliveryStatus = 'delivered') => ({
  seq, id: `fixture-${seq}`, senderId, senderName: members.find(member => member.id === senderId)?.name ?? senderId,
  recipientId, body, createdAt: new Date(Date.UTC(2026, 8, 29, 9, seq * 2)).toISOString(),
  threadId: 'fixture-requirement-1', deliveryStatus,
  thinking: '这段思考不应出现在聊天室', toolCalls: [{ name: 'bash', input: 'private' }],
})
const longText = `请按需求记录实施通知链路。${'交接内容需保持顺序和状态可追踪，'.repeat(85)}完成后通知助理更新待办。`
const rows = [
  make(1, 'requirements', 'assistant', '需求已经确认，请先生成待办，再交给开发。'),
  make(2, 'assistant', 'codes', '待办已建立，开发请开始实现。'),
  make(3, 'codes', 'assistant', '正在实现内部通信功能。', 'running'),
  make(4, 'logs', 'requirements', longText, 'failed'),
]

app.get('/api/workbench/state', (_request, response) => response.json({
  data: { tasks: [], plans: [], fixes: [], logs: [], requirements: [], codes: [], knowledge: [], knowledgeBases: [], knowledgeFolders: [] },
  profile: { name: '验收用户', motto: '' }, prefs: { theme: 'light', density: 'comfortable' }, empty: false,
}))
app.put('/api/workbench/prefs', (request, response) => response.json({ prefs: request.body ?? {} }))
app.get('/api/chatroom/messages', (request, response) => {
  requests += 1
  if (failing) return response.status(503).json({ error: 'fixture offline' })
  const all = rows
  const after = request.query.after === undefined ? 0 : Number(request.query.after)
  const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 100))
  const newer = all.filter(message => message.seq > after)
  const messages = newer.slice(0, limit)
  const watched = String(request.query.watch ?? '').split(',').map(Number).filter(Number.isSafeInteger)
  const updates = all.filter(message => watched.includes(message.seq))
  response.json({
    room: { id: 'internal', name: '内部聊天室' }, members, messages, updates,
    nextCursor: messages.at(-1)?.seq ?? after, hasMore: newer.length > messages.length,
  })
})
app.post('/api/chatroom/messages', async (request, response) => {
  const body = String(request.body?.body ?? '').trim()
  const key = String(request.body?.entryKey ?? '')
  if (!body || !key) return response.status(400).json({ error: '缺少正文或 entryKey' })
  const existing = byEntryKey.get(key)
  if (existing) return response.json({ message: existing })
  if (sendFailure === 'before') { sendFailure = 'none'; return response.status(503).json({ error: '模拟发送中断' }) }
  const mention = parseChatroomMentions(body)
  if (mention.multipleRecipients || mention.unknownMentions.length > 0) return response.status(400).json({ error: '一次只能点名一位已知成员' })
  const replied = rows.find(row => row.id === request.body?.replyTo)
  if (request.body?.replyTo && !replied) return response.status(400).json({ error: '回复消息不存在' })
  const item = {
    ...make(nextSeq++, 'user', mention.recipientId, body, mention.recipientId ? 'pending' : 'none'),
    threadId: replied?.threadId ?? `fixture-user-${key}`,
    replyTo: replied?.id ?? null,
  }
  rows.push(item)
  byEntryKey.set(key, item)
  if (sendDelayMs > 0) {
    const delay = sendDelayMs
    sendDelayMs = 0
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  if (sendFailure === 'after') { sendFailure = 'none'; return response.status(503).json({ error: '模拟回包丢失' }) }
  return response.status(201).json({ message: item })
})
app.get('/__fixture__/state', (_request, response) => response.json({ phase, failing, requests, messageCount: rows.length, entryKeys: [...byEntryKey.keys()] }))
app.post('/__fixture__/advance', (_request, response) => {
  phase += 1
  if (phase === 1) {
    rows[2] = { ...rows[2], deliveryStatus: 'delivered' }
    rows.push(make(nextSeq++, 'codes', 'assistant', '开发已完成，请助理将待办状态改为完成。'))
  } else if (phase === 2) rows.push(make(nextSeq++, 'assistant', 'requirements', '待办已更新为完成，交接闭环。'))
  response.json({ phase })
})
app.post('/__fixture__/fail', (request, response) => response.json({ failing: failing = request.body?.enabled === true }))
app.post('/__fixture__/send-failure', (request, response) => {
  sendFailure = ['before', 'after'].includes(request.body?.mode) ? request.body.mode : 'none'
  response.json({ mode: sendFailure })
})
app.post('/__fixture__/send-delay', (request, response) => {
  sendDelayMs = Math.min(2000, Math.max(0, Number(request.body?.milliseconds) || 0))
  response.json({ milliseconds: sendDelayMs })
})
app.get('/api/*path', (_request, response) => response.status(404).json({ error: 'fixture endpoint unavailable' }))

const server = app.listen(port, '127.0.0.1', () => console.log(`Chatroom UI fixture: http://127.0.0.1:${port}`))
const close = () => server.close(() => process.exit(0))
process.once('SIGINT', close)
process.once('SIGTERM', close)
