import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Requirements from '../src/workbench-app/modules/requirements/index.jsx'
import Records from '../src/workbench-app/modules/requirements/Records.jsx'
import ImportDialog, { selectedTaskDrafts } from '../src/workbench-app/modules/requirements/ImportDialog.jsx'
import RequirementCanvas from '../src/workbench-app/modules/requirements/Canvas.jsx'
import { buildRequirementCanvas } from '../src/workbench-app/modules/requirements/canvas-model.js'
import RequirementDraftCard from '../src/workbench-app/modules/requirements/DraftCard.jsx'
import { RequirementsStarterActions, RequirementsWelcome, alignHintVisible, starterDraft } from '../src/workbench-app/modules/requirements/Landing.jsx'
import { categoryOf, dispatchedRequirementIds } from '../src/workbench-app/modules/requirements/model.jsx'
import Tasks from '../src/workbench-app/modules/tasks/index.jsx'
import { addDays, todayISO } from '../src/workbench-app/util.mjs'

const requirementId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const updatedAt = '2026-09-28T12:00:00.000Z'
const requirement = {
  id: requirementId,
  title: '需求来源',
  status: 'todo',
  priority: 'high',
  category: 'fix',
  note: '## 验收条件\n- 能回到对应需求',
  updatedAt,
  taskDrafts: [
    { title: '任务一', priority: 'high', due: null, tag: '前端' },
    { title: '任务二', priority: 'normal', due: null, tag: '' },
  ],
}

const data = {
  requirements: [requirement],
  tasks: [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: '未来任务',
    priority: 'normal',
    due: addDays(todayISO(), 2),
    done: false,
    refs: [{ type: 'requirements', id: requirementId }],
  }, {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    title: '另一条需求的任务',
    priority: 'low',
    due: todayISO(),
    done: false,
    refs: [{ type: 'requirements', id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
  }],
}

const render = (Component: any, props: Record<string, unknown>) => renderToStaticMarkup(createElement(Component, props))
const records = render(Records, {
  data, initialSelectedId: requirementId, onImport: () => {}, navigate: () => {},
})
assert.match(records, /data-testid="req-reader-title"/)
assert.match(records, /data-testid="req-import-open"/)
assert.match(records, /data-testid="req-task"/)
// 分类标签：列表与阅读页都带，取值经 model 映射成中文（fix → 问题修复）。
assert.match(records, /data-testid="req-item-category"[^>]*>问题修复</)
assert.match(records, /data-testid="req-reader-category"[^>]*>问题修复</)
const legacyRecords = render(Records, {
  data: { ...data, requirements: [{ ...requirement, category: undefined }] },
  initialSelectedId: requirementId, onImport: () => {}, navigate: () => {},
})
assert.match(legacyRecords, /data-testid="req-reader-category"[^>]*>新功能</, '旧数据缺 category 按 new 展示')

const dialog = render(ImportDialog, { row: requirement, onClose: () => {}, onConfirm: () => {} })
assert.match(dialog, /data-testid="req-import-dialog"/)
assert.match(dialog, /data-testid="req-import-context"/)
assert.match(dialog, /验收条件/)
assert.match(dialog, /data-testid="req-import-category"[^>]*>问题修复</)
assert.match(dialog, /Agent 默认整理一条待办/)
assert.equal(dialog.split('data-testid="req-import-item"').length - 1, 2)
assert.match(dialog, /确认导入 2 条/)
// 默认单条：没有草稿时预览一条，文案说「这条」，仍可继续增减条目。
const singleDraftDialog = render(ImportDialog, {
  row: { ...requirement, taskDrafts: [] }, onClose: () => {}, onConfirm: () => {},
})
assert.equal(singleDraftDialog.split('data-testid="req-import-item"').length - 1, 1, '没有草稿时默认一条待办')
assert.match(singleDraftDialog, /确认导入这条待办/)
assert.match(singleDraftDialog, /data-testid="req-import-add"/)
const savedDialog = render(ImportDialog, {
  row: requirement, saved: true, error: '待办已保存，但列表刷新失败', onClose: () => {}, onConfirm: () => {},
})
assert.match(savedDialog, /role="alert"[^>]*>待办已保存，但列表刷新失败/)
assert.match(savedDialog, /重新加载待办/)
assert.match(savedDialog, /<fieldset(?=[^>]*data-testid="req-import-item")(?=[^>]*disabled)[^>]*>/)
const conflictDialog = render(ImportDialog, {
  row: requirement, conflict: true, conflictError: '需求已关联待办', onClose: () => {}, onConfirm: () => {}, onReloadLatest: () => {},
})
assert.match(conflictDialog, /data-testid="req-import-conflict-message"/)
assert.match(conflictDialog, /当前预览与服务端记录有冲突/)
assert.match(conflictDialog, /data-testid="req-import-conflict-server-error"[^>]*>服务端说明：需求已关联待办/)
assert.match(conflictDialog, /重新载入会用最新需求草稿替换当前预览/)
assert.match(conflictDialog, /data-testid="req-import-reload-latest"[^>]*>重新载入并预览/)
assert.match(conflictDialog, /<button(?=[^>]*data-testid="req-import-confirm")(?=[^>]*disabled)[^>]*>/)
const reloadFailureDialog = render(ImportDialog, {
  row: requirement, conflict: true, reloadError: '网络连接失败', onClose: () => {}, onConfirm: () => {}, onReloadLatest: () => {},
})
assert.match(reloadFailureDialog, /data-testid="req-import-reload-error"[^>]*>最新需求载入失败[^<]*网络连接失败/)
assert.match(reloadFailureDialog, /data-testid="req-import-reload-latest"[^>]*>重新载入并预览/)
const deletedDialog = render(ImportDialog, {
  row: requirement, deleted: true, onClose: () => {}, onConfirm: () => {},
})
assert.match(deletedDialog, /data-testid="req-import-deleted-message"/)
assert.doesNotMatch(deletedDialog, /data-testid="req-import-confirm"/)
const linkedTasksDialog = render(ImportDialog, {
  row: requirement,
  linkedTasks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '已关联待办', due: null, done: false }],
  onClose: () => {}, onConfirm: () => {}, onViewExistingTasks: () => {},
})
assert.match(linkedTasksDialog, /data-testid="req-import-existing-tasks"/)
assert.match(linkedTasksDialog, /已有 1 条关联待办/)
assert.match(linkedTasksDialog, /data-testid="req-import-view-existing-tasks"[^>]*>查看已有关联待办/)
assert.doesNotMatch(linkedTasksDialog, /data-testid="req-import-confirm"/)
const linkedTasksErrorDialog = render(ImportDialog, {
  row: requirement,
  linkedTasks: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: '已关联待办', due: null, done: false }],
  viewTasksError: '网络连接失败', onClose: () => {}, onConfirm: () => {}, onViewExistingTasks: () => {},
})
assert.match(linkedTasksErrorDialog, /data-testid="req-import-view-existing-tasks-error"[^>]*>刷新关联待办失败[^<]*网络连接失败/)

const selected = selectedTaskDrafts([
  { selected: true, title: ' 编辑后 ', priority: 'low', due: '', tag: ' 测试 ' },
  { selected: false, title: '', priority: 'normal', due: '', tag: '' },
])
assert.deepEqual(selected, { tasks: [{ title: '编辑后', priority: 'low', due: null, tag: '测试' }] })
assert.equal(selectedTaskDrafts([{ selected: false, title: '', priority: 'normal', due: '', tag: '' }]).error, '至少勾选一条待办')

// 需求描述引导：四件事的提纲 + 可点击示例（示例按钮把整段引导语交给 onChoose 填进输入框）。
const landing = render(RequirementsWelcome, { error: '', onChoose: () => {} })
for (const id of ['req-landing', 'req-guide', 'req-guide-points', 'req-guide-examples', 'req-example-categorize', 'req-example-export']) {
  assert.match(landing, new RegExp(`data-testid="${id}"`), `需求首页缺少 ${id}`)
}
for (const point of ['要解决的问题', '给谁用', '期望的行为', '边界与约束']) {
  assert.match(landing, new RegExp(point), `需求首页引导缺少「${point}」`)
}
assert.match(landing, /data-testid="req-example-categorize"[^>]*>[^<]*一眼看出每条需求属于/)
assert.doesNotMatch(render(RequirementsWelcome, { error: '' }), /data-testid="req-guide-examples"/, '没有填入回调时不渲染点不动的示例按钮')
assert.match(render(RequirementsStarterActions, { busy: false, status: 'live', modelName: 'fixture', onChoose: () => {} }), /data-testid="req-starter-idea"/)

// 点击填入的规则：同一前缀只替换引导语本身，已写进输入框的正文留在末尾。
assert.equal(starterDraft('', '', '帮我梳理：'), '帮我梳理：')
assert.equal(starterDraft('帮我梳理：', '帮我梳理：还要能导出', '先澄清目标：'), '先澄清目标：还要能导出')
assert.equal(starterDraft('帮我梳理：', '用户自己写的内容', '先澄清目标：'), '先澄清目标：用户自己写的内容')

// 对齐提示只在 Agent 回过一轮、回合结束且输入框还空着时出现，不每回合打扰。
const replied = [{ kind: 'user', text: '我想做个导出' }, { kind: 'assistant', text: 'Q1 给谁用？\nQ2 边界是什么？' }]
assert.equal(alignHintVisible(replied, false, ''), true)
assert.equal(alignHintVisible(replied, true, ''), false, '回合进行中不提示')
assert.equal(alignHintVisible(replied, false, '先回答 Q1'), false, '已经落笔不打扰')
assert.equal(alignHintVisible([{ kind: 'user', text: '我想做个导出' }], false, ''), false, '还没有 Agent 回复时不提示')
// 语义收窄：只看最后一条非空 assistant 正文，普通结论不触发（ego 实测误报的修复）。
const plainReply = [...replied, { kind: 'assistant', text: '布局测试通过，可以继续。' }]
assert.equal(alignHintVisible(plainReply, false, ''), false, '最后一条只是普通结论时不提示')
const answeredLater = [{ kind: 'assistant', text: 'Q1 给谁用？\nQ2 边界是什么？' }, { kind: 'user', text: '给运营用' }, { kind: 'assistant', text: '明白了，我来整理成文。' }]
assert.equal(alignHintVisible(answeredLater, false, ''), false, '更早的旧清单不算，只看最后一条')
assert.equal(alignHintVisible([{ kind: 'assistant', text: '先说说背景' }, { kind: 'notice', text: 'Q9 不算正文' }], false, ''), false, '非 assistant 条目不参与判定')
assert.equal(alignHintVisible([{ kind: 'assistant', text: '   ' }, { kind: 'assistant', text: 'Q1 先确认目标？' }], false, ''), true, '空正文跳过，回溯到上一条有内容的回复')

// 已转交群处理的判定：成功 chatroom_send 的参数全文提及的草稿 id 才算，失败/未提及/空转写都不算。
const draftRows = [{ id: 'req-dispatched-1' }, { id: 'req-untouched-2' }]
assert.deepEqual(
  [...dispatchedRequirementIds([{ kind: 'assistant', tools: [{ toolName: 'chatroom_send', status: 'success', args: { text: '请 @需求管理 接手 req-dispatched-1' } }] }], draftRows)],
  ['req-dispatched-1'],
)
assert.deepEqual(
  [...dispatchedRequirementIds([{ kind: 'toolResult', run: { toolName: 'chatroom_send', status: 'success', args: { requirementId: 'req-untouched-2' } } }], draftRows)],
  ['req-untouched-2'],
  '恢复历史里的 toolResult 条目同样计入',
)
assert.equal(dispatchedRequirementIds([{ kind: 'assistant', tools: [{ toolName: 'chatroom_send', status: 'error', args: { text: 'req-dispatched-1' } }] }], draftRows).size, 0, '失败的群发不算已转交')
assert.equal(dispatchedRequirementIds([{ kind: 'assistant', tools: [{ toolName: 'chatroom_send', status: 'success', args: { text: '没有引用任何草稿' } }] }], draftRows).size, 0, '未提及草稿 id 不算已转交')
assert.equal(dispatchedRequirementIds([], draftRows).size, 0, '空转写返回空集合')
assert.equal(dispatchedRequirementIds(undefined, draftRows).size, 0, '转写缺失时返回空集合')

// 草稿卡三种状态：草稿可导入、已导入转查看待办、已转交锁定为不可重复导入。
const draftCard = render(RequirementDraftCard, { row: requirement, busy: false, onImport: () => {}, onOpenTasks: () => {} })
assert.match(draftCard, /data-testid="req-draft-category"[^>]*>问题修复</, '草稿卡要显示分类徽标')
assert.match(draftCard, /data-testid="req-draft-import"[^>]*>预览并导入待办</)
assert.doesNotMatch(draftCard, /<button(?=[^>]*data-testid="req-draft-import")(?=[^>]*disabled)[^>]*>/, '草稿态导入按钮可点')
assert.doesNotMatch(draftCard, /data-testid="req-draft-dispatched"/)
const importedCard = render(RequirementDraftCard, {
  row: { ...requirement, importedAt: '2026-09-29T12:00:00.000Z' },
  dispatched: true, busy: false, onImport: () => {}, onOpenTasks: () => {},
})
assert.match(importedCard, /class="req-draft-label">已导入待办/)
assert.match(importedCard, /data-testid="req-draft-import"[^>]*>查看待办</)
assert.doesNotMatch(importedCard, /<button(?=[^>]*data-testid="req-draft-import")(?=[^>]*disabled)[^>]*>/, '已导入仍可查看待办，不受转交影响')
assert.doesNotMatch(importedCard, /data-testid="req-draft-dispatched"/, '已导入不再展示转交提示')
const dispatchedCard = render(RequirementDraftCard, { row: requirement, dispatched: true, busy: false, onImport: () => {}, onOpenTasks: () => {} })
assert.match(dispatchedCard, /data-testid="req-draft-dispatched"[^>]*>已转交群处理 · 请勿重复导入/)
assert.match(dispatchedCard, /<button(?=[^>]*data-testid="req-draft-import")(?=[^>]*disabled)[^>]*>已转交群处理</, '转交后导入按钮锁定且文案改为已转交群处理')

/* ================================================== 需求画布：转写投影 + SSR 树 */

// 一次 ask_user：两题（一题带选项、一题开放）；回执只含已作答题——工具取消后会中断后续提问。
const canvasRootText = '我想把需求推进过程画成一张图，先看清楚整体脉络再决定要不要导入待办'
const canvasAskRun = {
  toolCallId: 'call-canvas-1', toolName: 'ask_user', output: '', status: 'success', startedAt: 1,
  args: {
    questions: [
      { id: 'Q1', question: '这张图主要给谁看？', choices: [
        { label: '只看这个需求', description: '横向铺开，信息密度低但一眼看清分支' },
        { label: '跨需求总览', description: '需要聚合多条需求，首版不做' },
      ] },
      { id: 'Q2', question: '树的走向怎么排？', placeholder: '例如根在左、子级向右' },
    ],
  },
  details: { answers: [{ id: 'Q1', value: '只看这个需求', label: '只看这个需求' }] },
}
const canvasEntries = [
  { kind: 'user', id: 'canvas-user-1', at: 1, text: canvasRootText, imageCount: 0 },
  { kind: 'assistant', id: 'canvas-assistant-1', at: 2, text: '', tools: [canvasAskRun] },
  // 同一个 run 在 toolResult 里再出现一次：只能算一次分叉。
  { kind: 'toolResult', id: 'canvas-tool-1', at: 3, run: canvasAskRun },
]
const canvasDraftRecords = [
  { id: 'req-canvas-1', title: '需求画布首版', category: 'new', taskDrafts: [{ title: '投影' }], updatedAt: '2026-10-09T10:00:00.000Z' },
  { id: 'req-canvas-2', title: '已导入的那条', category: 'change', taskDrafts: [], importedAt: '2026-10-09T09:00:00.000Z', updatedAt: '2026-10-09T09:00:00.000Z' },
]

const canvasModel: any = buildRequirementCanvas({ entries: canvasEntries, records: canvasDraftRecords })
assert.ok(canvasModel, '有提问、有草稿时必须给出画布模型')
assert.equal(canvasModel.root.text, canvasRootText, '根节点取第一条非空 user 正文')
assert.equal(canvasModel.root.fullText, canvasRootText, '节点截断了也要留全文给 title')
assert.equal(canvasModel.questions.length, 2, '同一 ask_user 出现两次按 toolCallId 去重，每题一个分支')
assert.deepEqual(canvasModel.questions.map((question: any) => question.choices.map((choice: any) => choice.label)),
  [['只看这个需求', '跨需求总览'], []], '开放题没有选项，也要有自己的分支节点')
assert.equal(canvasModel.questions[0].answerLabel, '只看这个需求', '答案按题目 id 配对取干净 label')
assert.equal(canvasModel.questions[0].cancelled, false)
assert.equal(canvasModel.questions[1].answerLabel, null, '未作答的题没有答案文本')
assert.equal(canvasModel.questions[1].cancelled, true, '工具取消后中断提问：已结束却没答案的题按未作答处理')
assert.deepEqual(canvasModel.drafts.map((draft: any) => draft.row.id), ['req-canvas-1', 'req-canvas-2'], '记录原样传给产物节点')
assert.deepEqual(canvasModel.summary, { asked: 2, answered: 1, drafts: 2, imported: 1 })
// 整卡取消：details.cancelled 覆盖本批全部题目，不计任何答案。
const cancelledCardModel: any = buildRequirementCanvas({ entries: [
  { kind: 'user', id: 'u', text: '画个图' },
  { kind: 'assistant', id: 'a', text: '', tools: [{ ...canvasAskRun, details: { cancelled: true } }] },
], records: [] })
assert.deepEqual(cancelledCardModel.questions.map((question: any) => question.cancelled), [true, true])
assert.equal(cancelledCardModel.summary.answered, 0)
// 超长诉求截断到 120 字，全文留在 fullText 里。
const longRoot = '需求'.repeat(80)
const longRootModel: any = buildRequirementCanvas({ entries: [
  { kind: 'user', id: 'u', text: longRoot },
  { kind: 'assistant', id: 'a', text: '', tools: [canvasAskRun] },
], records: [] })
assert.equal(longRootModel.root.text.length, 121, '根节点超长正文截断到 120 字加省略号')
assert.equal(longRootModel.root.fullText, longRoot)
// 没问过、也没草稿的会话没有可画内容，交回空态。
assert.equal(buildRequirementCanvas({ entries: [], records: [] }), null)
assert.equal(buildRequirementCanvas({}), null, '缺参不抛错，按空会话处理')

const canvasMarkup = render(RequirementCanvas, {
  entries: canvasEntries, records: canvasDraftRecords, dispatchedIds: new Set(['req-canvas-1']),
  busy: false, onImport: () => {}, onOpenTasks: () => {},
})
assert.match(canvasMarkup, /data-testid="req-canvas"/, '画布容器缺失')
assert.match(canvasMarkup, /data-testid="req-canvas-summary"/, '画布缺收敛指示行')
assert.ok(canvasMarkup.includes('已拍板 1/2 · 草稿 2 条 · 已导入 1'), '收敛行要报拍板进度、草稿与导入数')
assert.ok(!canvasMarkup.includes('data-testid="req-canvas-converged"'), '还有题没答完时不得宣告收敛')
// 诉求是画布题头：文本包在 root-text 里，位置在收敛行之后、树之前（不被树流卷走）。
assert.match(canvasMarkup, /data-testid="req-canvas-root"[^>]*><span class="req-canvas-root-label">诉求<\/span><span class="req-canvas-root-text">我想把需求推进过程画成一张图/)
assert.ok(canvasMarkup.indexOf('data-testid="req-canvas-root"') < canvasMarkup.indexOf('class="req-canvas-tree"'), '诉求题头在树之前')
assert.equal(canvasMarkup.split('data-testid="req-canvas-question"').length - 1, 2, '两题各一个分支节点')
assert.match(canvasMarkup, /data-testid="req-canvas-question" title="这张图主要给谁看？"/, '题干全文进 title 提示')
assert.equal(canvasMarkup.split('data-testid="req-canvas-choice"').length - 1, 2, '每题的路经选项都画成边')
assert.match(canvasMarkup, /class="req-canvas-choice is-picked" data-testid="req-canvas-choice" title="横向铺开，信息密度低但一眼看清分支"/, '被选中的边加粗高亮，取舍说明进 title')
assert.match(canvasMarkup, /class="req-canvas-choice" data-testid="req-canvas-choice" title="需要聚合多条需求，首版不做"/, '没选中的边保留取舍说明备选')
// 选择题的被选边已用 is-picked 表达结果，不再重复渲染答案节点（夹具里 Q1 已答、Q2 取消）。
assert.equal(canvasMarkup.split('data-testid="req-canvas-answer"').length - 1, 1, '只有取消/等待/自由输入才渲染答案节点')
assert.ok(canvasMarkup.includes('未作答（已取消）'), '取消的题也要有终止节点，不冒充答案')
assert.equal(canvasMarkup.split('data-testid="req-canvas-draft"').length - 1, 2, '每条记录一个产物节点')
assert.match(canvasMarkup, /data-testid="req-canvas-draft"><div class="req-draft" data-testid="req-draft">/, '产物节点内嵌现有草稿卡')
assert.match(canvasMarkup, /data-testid="req-draft-category"[^>]*>新功能</, '产物节点保留分类徽标')
assert.match(canvasMarkup, /data-testid="req-draft-import"[^>]*>查看待办</, '已导入的产物转查看待办')
assert.match(canvasMarkup, /data-testid="req-draft-dispatched"/, '转交集合要透传到产物节点')
assert.doesNotMatch(canvasMarkup, /undefined/, '画布不得泄漏 undefined')

// 全部答完且已有草稿：收敛指示升级为「可确认导入」。
const convergedMarkup = render(RequirementCanvas, {
  entries: [
    { kind: 'user', id: 'u', text: '画个图' },
    { kind: 'assistant', id: 'a', text: '', tools: [{ ...canvasAskRun, details: { answers: [
      { id: 'Q1', value: '只看这个需求', label: '只看这个需求' },
      { id: 'Q2', value: '根在左、子级向右', label: '根在左、子级向右' },
    ] } }] },
  ],
  records: [canvasDraftRecords[0]], dispatchedIds: new Set(), busy: false, onImport: () => {}, onOpenTasks: () => {},
})
assert.ok(convergedMarkup.includes('已拍板 2/2'))
assert.match(convergedMarkup, /data-testid="req-canvas-converged"[^>]*>需求已收敛，可确认导入</)
assert.match(convergedMarkup, /data-testid="req-canvas-answer"[^>]*>根在左、子级向右</, '自由输入的答案保留答案节点')

// 空会话：没有可画内容时给空态，而不是一块空白画布。
const emptyCanvas = render(RequirementCanvas, { entries: [], records: [], dispatchedIds: new Set(), busy: false, onImport: () => {}, onOpenTasks: () => {} })
assert.match(emptyCanvas, /data-testid="req-canvas-empty"/)
assert.ok(emptyCanvas.includes('还没有可画的需求脉络'))
assert.doesNotMatch(emptyCanvas, /data-testid="req-canvas-root"/)

// 需求工作区：与代码开发同款双列——左列画布主区，右列需求对话常驻，SSR 同屏可见；
// 待确认徽标要等对话上报本会话后才出现。画布按钮是主区切换（不再是三页签之一），对话页签已退役。
const workspace = render(Requirements, { data: { requirements: [requirement], tasks: [] }, prefs: {} })
assert.match(workspace, /data-testid="req-workspace"/, '需求工作区根容器缺失')
assert.match(workspace, /data-testid="req-canvas-tab"[^>]*>需求画布/, '需求工作区缺主区切回画布按钮')
assert.match(workspace, /data-testid="req-records-tab"/, '需求工作区缺切到记录的按钮')
assert.match(workspace, /data-testid="req-trace-by-id"/, '按 ID 追踪入口应保留在左列工具栏')
assert.match(workspace, /data-testid="req-open-tasks"/, '待办列表入口应保留在左列工具栏')
// 绑定工作区回显：SSR 无数据时显示 fallback 文案（fetch 在 effect 里，渲染期不发请求）。
assert.match(workspace, /data-testid="req-workspace-root"[^>]*>需求 Agent 配置中的工作区</, '工具栏副标题应回显绑定工作区（SSR 为 fallback 文案）')
assert.doesNotMatch(workspace, /data-testid="req-chat-tab"/, '「需求对话」页签已退役：对话是右列常驻')
// 同屏：画布主区与对话列都在，且对话挂在右列容器里。
assert.match(workspace, /data-testid="req-canvas"/, '默认主区应是画布')
assert.match(workspace, /data-testid="req-chat-column"[^>]*aria-label="需求助手对话"/, '需求对话列缺失')
const chatColumnIndex = workspace.indexOf('data-testid="req-chat-column"')
const conversationIndex = workspace.indexOf('data-testid="req-conversation"')
assert.ok(chatColumnIndex >= 0 && conversationIndex > chatColumnIndex, '需求对话应常驻在右列容器内')
// 窄屏换列按钮（899px 以下才显示）与 data-mobile-view 一起进 SSR，门禁只认 DOM 证据。
assert.match(workspace, /data-testid="req-show-canvas"/, '窄屏缺「画布」切换按钮')
assert.match(workspace, /data-testid="req-show-chat"/, '窄屏缺「需求对话」切换按钮')
assert.match(workspace, /data-testid="req-workspace"[^>]*data-mobile-view="canvas"/, '窄屏默认显示画布列')
assert.doesNotMatch(workspace, /undefined/, '需求工作区不得泄漏 undefined')

// 按 ID 直达（待办跳转等）：初始主区直接落到记录，对话仍在右列。
const recordsTarget = render(Requirements, {
  data: { requirements: [requirement], tasks: [] }, prefs: {}, navigationTarget: { selectedId: requirementId },
})
assert.match(recordsTarget, /data-testid="req-split"/, '带 selectedId 进入时应直接显示记录主区')
assert.match(recordsTarget, /data-testid="req-reader-title"/, '带 selectedId 进入时应选中该记录')
assert.match(recordsTarget, /data-testid="req-chat-column"/, '直达记录时对话列不得消失')

// 分类映射：四档中文标签，旧数据缺字段按契约缺省 new，未知取值原样显示。
assert.deepEqual(categoryOf('fix'), { value: 'fix', label: '问题修复', tone: 'danger' })
assert.equal(categoryOf('enhancement').label, '体验优化')
assert.equal(categoryOf(undefined).label, '新功能', '旧数据缺 category 缺省 new')
assert.equal(categoryOf('experiment').label, 'experiment', '未知分类原样显示')

const tasks = render(Tasks, {
  data, modules: [{ id: 'requirements', label: '需求管理' }],
  navigationTarget: { scope: 'all', requirementId },
  prefs: { tasksScope: 'today' },
})
assert.match(tasks, /data-testid="task-row"/)
assert.match(tasks, /data-testid="task-requirement-ref"/)
assert.match(tasks, /data-testid="tasks-source-filter"/)
assert.match(tasks, /来自需求「需求来源」 · 1 条待办/)
assert.match(tasks, /data-testid="tasks-source-clear"/)
assert.equal(tasks.split('data-testid="task-row"').length - 1, 1, '来源筛选只显示对应需求的任务')

const unlinkedTasks = render(Tasks, {
  data: { ...data, tasks: data.tasks.slice(1) },
  navigationTarget: { scope: 'all', requirementId }, prefs: { tasksScope: 'all' },
})
assert.match(unlinkedTasks, /这条需求还没有关联待办/)
assert.match(unlinkedTasks, /来自需求「需求来源」 · 0 条待办/)

const ordinaryTasks = render(Tasks, {
  data, modules: [{ id: 'requirements', label: '需求管理' }], prefs: { tasksScope: 'all' },
})
assert.equal(ordinaryTasks.split('data-testid="task-row"').length - 1, 2, '普通待办入口显示全量任务')
assert.doesNotMatch(ordinaryTasks, /data-testid="tasks-source-filter"/)

// 等待提示挂在有 hooks 的 RequirementsChat 上，SSR 不可达，改为源码断言：
// 必须在回合进行中（busy && live）与对齐提示同槽位出现，否则 5-6 分钟影响分析期间没有任何预期管理。
const chatSource = readFileSync(
  new URL('../src/workbench-app/modules/requirements/RequirementsChat.jsx', import.meta.url),
  'utf8',
)
assert.match(chatSource, /data-testid="req-waiting-hint"/, '需求对话缺少等待提示')
assert.match(chatSource, /busy && status === 'live' &&/, '等待提示只应在回合进行中且连接可用时出现')
assert.match(chatSource, /正在检索项目材料与需求库，复杂需求的影响分析可能需要几分钟/, '等待提示文案应说明耗时预期')
assert.doesNotMatch(chatSource, /req-session-drafts/, '底部草稿条已退役：产物确认入口只留在需求画布')
assert.match(chatSource, /onTranscript\?\.\(\{ transcript, sessionId \}\)/, '需求对话要把转写与会话 id 交给画布宿主')
const canvasSource = readFileSync(
  new URL('../src/workbench-app/modules/requirements/Canvas.jsx', import.meta.url),
  'utf8',
)
assert.match(canvasSource, /<RequirementDraftCard/, '草稿卡必须复用 DraftCard 组件')
const canvasModelSource = readFileSync(
  new URL('../src/workbench-app/modules/requirements/canvas-model.js', import.meta.url),
  'utf8',
)
assert.doesNotMatch(canvasModelSource, /window\.|document\./, '画布投影必须是纯函数，不在渲染期碰浏览器 API')

console.log('requirements UI: two-column workspace (canvas main + resident chat column), records landing by id, selected history, import preview, category badges, landing guidance, align-hint semantics, draft handoff card, waiting hint, requirement canvas projection/SSR and future task source passed')
