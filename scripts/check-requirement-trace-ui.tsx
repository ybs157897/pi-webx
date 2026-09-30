import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Records from '../src/workbench-app/modules/requirements/Records.jsx'
import Requirements from '../src/workbench-app/modules/requirements/index.jsx'
import TraceContent, { deliveryAcceptanceBlockers } from '../src/workbench-app/modules/requirements/TraceContent.jsx'
import TraceDeliveryForm from '../src/workbench-app/modules/requirements/TraceDeliveryForm.jsx'
import TraceDrawer, { parseTraceLookup, readTrace, requirementDeliveryFingerprint, requirementDeliveryPayload } from '../src/workbench-app/modules/requirements/TraceDrawer.jsx'
import { createTraceRequestScope } from '../src/workbench-app/modules/requirements/TraceRequestScope.js'

const requirementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const sourceSessionId = '11111111-1111-4111-8111-111111111111'
const codesSessionId = '22222222-2222-4222-8222-222222222222'
const assistantSessionId = '33333333-3333-4333-8333-333333333333'
const requirement = { id: requirementId, title: '核对发布链路', note: '需要真实验证', status: 'doing',
  sourceSessionId, updatedAt: '2026-09-30T09:00:00Z' }
const trace = {
  requirementId, humanId: 'REQ-000001', requirementVersion: 3, stage: 'verifying', archived: false,
  requirement, acceptanceReady: false, blockers: ['协作分工尚未全部完成', '还缺少成功 Run'],
  coverage: { historical: false, warnings: ['旧记录的早期事件可能不完整'] },
  events: [
    { id: 'event-2', seq: 2, type: 'chatroom_assignment_created', time: '2026-09-30T09:02:00Z', actor: 'codes', summary: '开始开发',
      refs: { taskId: 'task-1', workspaceKey: 'private-workspace', sessionId: 'private-session' } },
    { id: 'event-1', seq: 1, type: 'requirement.created', time: '2026-09-30T09:00:00Z', actor: 'user', summary: '保存草稿', refs: [] },
    { id: 'event-early', seq: 5, type: 'task.linked', time: '2026-09-30T08:00:00Z', actor: 'record', summary: '早期关联待办', refs: [] },
    { id: 'event-unknown', seq: 4, type: 'requirement.historical', time: null, actor: 'record', summary: '存量基线', refs: [] },
  ],
  links: {
    tasks: [{ id: 'task-1', title: '实现功能', done: true }],
    collaborationTasks: [{ id: 'work-1', title: '开发与验证', status: 'running' }],
    assignments: [{ id: 'assignment-1', agentId: 'codes', status: 'running', summary: '开发中',
      sessionId: codesSessionId, profileRevision: 'a'.repeat(64) },
    { id: 'assignment-2', agentId: 'assistant', status: 'completed', summary: '已协调', sessionId: assistantSessionId }],
    runs: [{ id: 'run-failed', status: 'failed', agentId: 'codes', requirementVersion: 3,
      failureCategory: 'provider_stream_incomplete', error: '模型服务输出流未完整结束',
      rawBody: 'sk-secret raw token body', apiKey: 'sk-secret',
      sessionId: 'private-session', checkpoint: 'secret checkpoint' },
      { id: 'run-success', status: 'succeeded', agentId: 'codes', requirementVersion: 3,
        sessionId: codesSessionId }],
    messages: [{ id: 'message-1', body: '已开始处理' }],
    tools: [{ id: 'tool-1', toolName: 'read', status: 'succeeded', exitCode: 0,
      resultBytes: 128, resultHash: 'sha256:abc123', args: 'secret arguments' }],
  },
  deliveries: [{ id: 'delivery-1', status: 'submitted', summary: '提交者报告完成',
    evidence: [{ kind: 'test', ref: 'test-report-1', label: '离线测试', verification: 'reported' }],
    runIds: ['run-success'], requirementVersion: 3,
    createdAt: '2026-09-30T09:03:00Z', updatedAt: '2026-09-30T09:03:00Z', reviews: [] }],
}
const render = (Component: any, props: Record<string, unknown> = {}) => renderToStaticMarkup(h(Component, props))

const records = render(Records, { data: { requirements: [requirement], tasks: [] }, initialSelectedId: requirementId })
assert.match(records, /data-testid="req-trace-open"/, '选中需求详情提供全链路追踪入口')
const emptyWorkspace = render(Requirements, { data: { requirements: [], tasks: [] }, prefs: {} })
assert.match(emptyWorkspace, /data-testid="req-trace-by-id"/, '没有需求记录时仍能按 ID 查看 tombstone')
const emptyLookup = render(TraceDrawer, { requirementId: '' })
assert.match(emptyLookup, /data-testid="req-trace-await-id"/, '空 ID 打开查找态，不请求空地址')
assert.match(emptyLookup, /data-testid="req-trace-id-input"/, '空记录查找态仍可输入 UUID 或 REQ 编号')
assert.doesNotMatch(emptyLookup, /data-testid="req-trace-loading"/, '空 ID 不应显示无限加载')
const completedRecord = render(Records, { data: { requirements: [{ ...requirement, status: 'done' }], tasks: [] },
  initialSelectedId: requirementId })
assert.match(completedRecord, /业务完成/, '旧状态 done 应表述为业务完成')
assert.doesNotMatch(completedRecord, /已交付/, '业务状态不能冒充正式人工接受')
const shell = render(TraceDrawer, { requirementId })
for (const id of ['req-trace-drawer', 'req-trace-id-input', 'req-trace-lookup', 'req-trace-copy', 'req-trace-loading'])
  assert.match(shell, new RegExp(`data-testid="${id}"`))
assert.match(shell, /role="dialog" aria-modal="true"/, '追踪抽屉必须可由键盘和读屏定位')
assert.match(shell, new RegExp(requirementId), '打开时以当前选中需求 ID 查询')

const detail = render(TraceContent, { trace })
for (const id of ['req-trace-overview', 'req-trace-timeline', 'req-trace-links', 'req-trace-deliveries',
  'req-trace-evidence', 'req-trace-blockers', 'req-trace-coverage-warnings', 'req-trace-human-id', 'req-trace-sessions'])
  assert.match(detail, new RegExp(`data-testid="${id}"`))
for (const id of [sourceSessionId, codesSessionId, assistantSessionId])
  assert.match(detail, new RegExp(id), '真实 UUID 会话关联应可见')
assert.equal((detail.match(/data-testid="req-trace-session-copy"/g) || []).length, 3,
  '来源与各 Agent 的真实 UUID 均应可复制')
assert.match(detail, /来源会话可能讨论过多个需求，不能据此把其中每条内容归属此需求/, '来源会话只能作为关联线索')
assert.match(detail, /data-testid="req-trace-profile-revision"/, '配置快照哈希作为调试线索')
assert.deepEqual([...detail.matchAll(/data-testid="req-trace-event"[^>]*data-event-type="([^"]+)"/g)].map(match => match[1]),
  ['requirement.historical', 'task.linked', 'requirement.created', 'chatroom_assignment_created'],
  '时间线须先放未知基线，再按真实时间排序，seq 仅作兜底')
assert.match(detail, /data-testid="req-trace-time-unknown">时间未知/, '未知基线不能伪造时间')
assert.match(detail, /业务记录/, 'record actor 显示业务记录')
assert.match(detail, /待办关联/, '业务 journal dot 事件显示中文')
assert.doesNotMatch(detail, /1970/, '未知时间不得误显示为 Unix 纪元')
assert.match(detail, /业务任务已完成/, '业务完成仅显示在任务证据里')
assert.match(detail, /任务：task-1/, '事件引用应展示允许公开的实体关联')
assert.match(detail, /data-testid="req-trace-acceptance">尚未人工接受/, 'submitted 不得冒充正式交付')
assert.match(detail, /data-testid="req-trace-stage">验证中/, '已提交待审阅仍处于 verifying')
assert.doesNotMatch(detail, /data-testid="req-trace-stage">正式交付已接受/, 'submitted 不得呈现交付终态')
assert.match(detail, /<button[^>]*disabled=""[^>]*data-testid="req-trace-accept"/, '阻塞项存在时不得提供可点的接受')
assert.match(detail, /data-testid="req-trace-reject"/, '不满足接受条件时仍可退回')
assert.match(detail, /提交者报告/, 'reported 证据须标明来源')
assert.match(detail, /test-report-1/, '证据说明不能遮蔽实际引用')
assert.match(detail, /data-testid="req-trace-result-hash"/, '工具结果仅展示摘要哈希')
assert.match(detail, /退出码：0/, '工具退出码可供复核')
assert.match(detail, /结果字节数：128/, '工具结果大小可供复核')
assert.match(detail, /data-testid="req-trace-failure-category">失败分类：provider_stream_incomplete/, '运行失败分类应可追踪')
assert.match(detail, /data-testid="req-trace-run-error">失败原因：模型服务输出流未完整结束/, '只显示安全归类后的中文摘要')
assert.doesNotMatch(detail, /已验证|private-session|private-workspace|secret checkpoint|secret arguments|sk-secret|raw token body/,
  '无效 session 字符串和内部 checkpoint/工作区/工具参数均不显示')
const accepted = render(TraceContent, { trace: { ...trace, acceptanceReady: true, blockers: [],
  deliveries: [{ ...trace.deliveries[0], status: 'accepted', reviews: [{ id: 'review-1', decision: 'accept', actor: 'user', createdAt: '2026-09-30T09:05:00Z', comment: '已核对' }] }] } })
assert.match(accepted, /data-testid="req-trace-acceptance">当前版本已人工接受/)
assert.match(accepted, /data-testid="req-trace-review-record"/, '审阅决定应保留在交付记录中')
const superseded = render(TraceContent, { trace: { ...trace, requirementVersion: 4, acceptanceReady: false,
  deliveries: [{ ...trace.deliveries[0], status: 'accepted', requirementVersion: 3 }] } })
assert.match(superseded, /data-testid="req-trace-acceptance">当前版本未接受（历史版本已接受）/,
  '旧版本接受不能覆盖当前修订的正式交付状态')
const confirm = render(TraceContent, { trace: { ...trace, acceptanceReady: true, blockers: [] },
  reviewTarget: { deliveryId: 'delivery-1', decision: 'accept' }, reviewComment: '核对无误' })
assert.match(confirm, /data-testid="req-trace-review-confirm"/)
assert.match(confirm, /data-testid="req-trace-review-submit">确认接受/)
assert.deepEqual(deliveryAcceptanceBlockers({ ...trace, acceptanceReady: true }, trace.deliveries[0]), [],
  '有当前版本成功 Run 的交付才可进入正式接受')
assert.match(render(TraceContent, { trace: { ...trace, acceptanceReady: true,
  deliveries: [{ ...trace.deliveries[0], runIds: [] }] } }), /data-testid="req-trace-delivery-blocker"/,
  '需求总体就绪仍不能接受无 Run 的交付')
assert.deepEqual(deliveryAcceptanceBlockers({ ...trace, requirementVersion: 4 }, trace.deliveries[0])[0],
  '这份交付属于旧需求版本')

const form = render(TraceDeliveryForm, { trace, summary: '真实成果', evidence: [{ kind: 'commit', ref: 'abc123', label: '提交' }] })
for (const id of ['req-trace-delivery-form', 'req-trace-delivery-summary', 'req-trace-evidence-kind',
  'req-trace-evidence-ref', 'req-trace-run-ids', 'req-trace-run-select', 'req-trace-delivery-submit'])
  assert.match(form, new RegExp(`data-testid="${id}"`))
assert.match(form, /run-success/, '只从真实成功 Run 提供快捷选择')
assert.doesNotMatch(form, /<option value="run-failed"/, '失败 Run 不应作为成功运行候选')
const payload = requirementDeliveryPayload(trace, '真实成果', [{ kind: 'commit', ref: 'abc123' }], ['run-success'])
assert.deepEqual(payload, { expectedRequirementVersion: 3, expectedUpdatedAt: requirement.updatedAt,
  summary: '真实成果', evidence: [{ kind: 'commit', ref: 'abc123' }], runIds: ['run-success'] },
  '提交交付必须同时携带数字修订与更新时间')
assert.notEqual(requirementDeliveryFingerprint(trace, payload.summary, payload.evidence, payload.runIds),
  requirementDeliveryFingerprint({ ...trace, requirementVersion: 4 }, payload.summary, payload.evidence, payload.runIds),
  '同一时间戳下修订变化也必须换失败重试指纹')
const acceptedStage = render(TraceContent, { trace: { ...trace, stage: 'delivered', acceptanceReady: true,
  deliveries: [{ ...trace.deliveries[0], status: 'accepted' }] } })
assert.match(acceptedStage, /data-testid="req-trace-stage">正式交付已接受/)

assert.deepEqual(parseTraceLookup('id:REQ-000001'), { id: 'REQ-000001', lookup: 'id', explicit: true })
assert.deepEqual(parseTraceLookup('req:REQ-000001'), { id: 'REQ-000001', lookup: 'human', explicit: true })
assert.deepEqual(parseTraceLookup('REQ-000001'), { id: 'REQ-000001', lookup: 'auto', explicit: false })
assert.deepEqual(parseTraceLookup('id:foo', 'id'), { id: 'id:foo', lookup: 'id', explicit: false },
  '已知原始 ID 的 id: 前缀必须视为字面值')
assert.deepEqual(parseTraceLookup('req:foo', 'id'), { id: 'req:foo', lookup: 'id', explicit: false },
  '已知原始 ID 的 req: 前缀必须视为字面值')
const originalFetch = globalThis.fetch
const requestedUrls: string[] = []
try {
  globalThis.fetch = (async (url: string) => {
    requestedUrls.push(String(url))
    const human = String(url).includes('lookup=human')
    return { ok: true, status: 200, json: async () => ({
      requirementId: human ? requirementId : 'REQ-000001',
      humanId: human ? 'REQ-000001' : 'REQ-000002', events: [],
    }) } as Response
  }) as typeof fetch
  await readTrace('id:REQ-000001')
  await readTrace('req:REQ-000001')
  await readTrace('REQ-000001', undefined, 'id')
  assert.deepEqual(requestedUrls, [
    '/api/workbench/requirements/REQ-000001/trace?lookup=id',
    '/api/workbench/requirements/REQ-000001/trace?lookup=human',
    '/api/workbench/requirements/REQ-000001/trace?lookup=id',
  ], '明确原始 ID/编号与已知详情 ID 必须使用对应 lookup')
  globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: 'private detail' }) })) as typeof fetch
  await assert.rejects(() => readTrace('REQ-000001'), /id:原始ID 或 req:编号/,
    '有歧义的 auto 查询只显示安全消歧提示')
  globalThis.fetch = (async (url: string) => {
    requestedUrls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ requirementId: 'id:foo', humanId: 'REQ-000003', events: [] }) } as Response
  }) as typeof fetch
  await readTrace('id:foo', undefined, 'id')
  await readTrace('id:id:foo')
  assert.deepEqual(requestedUrls.slice(-2), [
    '/api/workbench/requirements/id%3Afoo/trace?lookup=id',
    '/api/workbench/requirements/id%3Afoo/trace?lookup=id',
  ], '字面原始 ID 与显式消歧写法均指向同一根')
} finally { globalThis.fetch = originalFetch }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const scope = createTraceRequestScope('A')
scope.activate()
const oldMutation = scope.beginMutation('A')
assert.ok(oldMutation)
const delayedMutation = deferred<string>()
const applied: string[] = []
const mutationResult = delayedMutation.promise.then(value => { if (scope.isCurrent(oldMutation)) applied.push(value) })
assert.equal(scope.switchTo('B'), false, 'A mutation 未结束时不能切换到 B')
assert.equal(scope.beginMutation('A'), null, '同一 drawer 不得启动第二个 mutation')
scope.deactivate()
scope.activate() // React StrictMode effect 重放，旧 token 不能复活
assert.equal(scope.isCurrent(oldMutation), false)
assert.equal(scope.switchTo('B'), true)
const currentLookup = scope.beginLookup('B')
delayedMutation.resolve('stale A')
await mutationResult
assert.deepEqual(applied, [], '卸载 A / 重开 B 后迟到 mutation 不得写回')
assert.equal(scope.isCurrent(currentLookup), true)
const oldLookup = deferred<string>()
const newLookup = deferred<string>()
const staleToken = scope.beginLookup('B')
const staleResult = oldLookup.promise.then(value => { if (scope.isCurrent(staleToken)) applied.push(value) })
assert.equal(scope.switchTo('C'), true)
const freshToken = scope.beginLookup('C')
const freshResult = newLookup.promise.then(value => { if (scope.isCurrent(freshToken)) applied.push(value) })
newLookup.resolve('current C')
oldLookup.resolve('late B')
await Promise.all([freshResult, staleResult])
assert.deepEqual(applied, ['current C'], '旧 GET 晚到也不得覆盖新 GET')

console.log('requirement trace UI: SSR entry, timeline, evidence, blockers, review and delivery form passed')
