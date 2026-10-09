/**
 * 需求画布投影：把一次需求会话的转写折叠成「根 → 提问分叉 → 答案 / 草稿产物」的决策树。
 *
 * 纯函数、SSR 安全：只读 entry 与记录字段，不碰 window/document，也不发请求——
 * 画布是前端投影，工具、提示词与服务端都不参与。
 *
 * 数据来路（形状见 `src/shared/transcript.ts` 与 `server/module-agents/ask-user.ts`）：
 *   - 根：第一条非空 user entry 的正文（截断到 120 字，全文留在 `fullText` 里给 title）；
 *   - 分叉：`ask_user` 工具的 ToolRun。同一个 run 会同时挂在 assistant entry 的 `tools`
 *     和 toolResult entry 的 `run` 上，按 toolCallId 去重；`args.questions` 每题一个节点。
 *   - 答案：`run.details.answers` 按题目 id 配对（卡片载荷 `{id,value,label}`、工具回执
 *     `{id,answer}` 都认），取 label/value/answer 里第一个非空文本；`details.cancelled`
 *     是整卡取消。工具在用户取消后中断后续提问，所以已结束（非 running）却没有答案的题
 *     一律按「用户取消/未作答」处理，不给假答案。
 *   - 产物：本会话的 requirements 记录，`row` 原样交给 RequirementDraftCard。
 */

/** 根节点正文截断长度；节点在画布上只占一列宽，全文走 title。 */
const ROOT_TEXT_LIMIT = 120

function text(value) {
  return typeof value === 'string' ? value : ''
}

/** 收敛展示：超长截断加省略号，空白串归一成空串。 */
function clip(value, limit) {
  const trimmed = text(value).trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/** 第一个非空文本：label 优先（用户看到的），退到 value / answer（自由输入或旧回执）。 */
function firstText(...values) {
  for (const value of values) {
    const trimmed = text(value).trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 按出现顺序收集去重后的 ask_user run（assistant.tools 与 toolResult.run 两个来源）。 */
function askRuns(entries) {
  const runs = new Map()
  const order = []
  const add = run => {
    if (!run || run.toolName !== 'ask_user') return
    const key = text(run.toolCallId) || `anonymous-${String(order.length)}`
    const existing = runs.get(key)
    if (existing) {
      // 先到的是调用、后到的是回执：只把拿到结构化结果的那份换进来，答案不被空壳覆盖。
      if (existing.details === undefined && run.details !== undefined) runs.set(key, run)
      return
    }
    runs.set(key, run)
    order.push(key)
  }
  for (const entry of entries ?? []) {
    if (entry?.kind === 'assistant') for (const run of entry.tools ?? []) add(run)
    else if (entry?.kind === 'toolResult') add(entry.run)
  }
  return order.map(key => runs.get(key))
}

/** args.questions → 分支题目（缺 id 时按位次补 `q{n}`，补齐题干与选项的干净文本）。 */
function askedQuestions(run) {
  const batch = run?.args?.questions
  if (!Array.isArray(batch)) return []
  const questions = []
  batch.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const question = text(entry.question).trim()
    if (question === '') return
    const choices = (Array.isArray(entry.choices) ? entry.choices : []).flatMap(choice => {
      if (!choice || typeof choice !== 'object') return []
      const label = text(choice.label).trim()
      return label === '' ? [] : [{ label, description: text(choice.description).trim() }]
    })
    questions.push({ id: text(entry.id).trim() || `q${String(index + 1)}`, question, choices })
  })
  return questions
}

/** details → 按题目 id 配对的答案；`cancelledCard` 是整卡取消，`finished` 表示 run 已结束。 */
function answersOf(run) {
  const byQuestion = new Map()
  const details = run?.details
  let cancelledCard = false
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    if (details.cancelled === true) cancelledCard = true
    for (const entry of Array.isArray(details.answers) ? details.answers : []) {
      if (!entry || typeof entry !== 'object') continue
      const id = text(entry.id).trim()
      if (id === '') continue
      byQuestion.set(id, { label: firstText(entry.label, entry.value, entry.answer), cancelled: entry.cancelled === true })
    }
  }
  return { byQuestion, cancelledCard, finished: run?.status !== 'running' }
}

/**
 * 画布树模型 + 汇总计数；没有可画内容（没问过、也没草稿）时返回 null，由调用方渲染空态。
 * `questions` 是每题一个节点（含开放题），`drafts` 每条约一个产物节点。
 */
export function buildRequirementCanvas({ entries, records } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const rootEntry = list.find(entry => entry?.kind === 'user' && text(entry.text).trim() !== '')

  const questions = []
  for (const run of askRuns(list)) {
    const asked = askedQuestions(run)
    if (asked.length === 0) continue
    const { byQuestion, cancelledCard, finished } = answersOf(run)
    for (const item of asked) {
      const answer = byQuestion.get(item.id)
      questions.push({
        kind: 'question',
        id: item.id,
        runId: text(run.toolCallId),
        question: item.question,
        choices: item.choices,
        answerLabel: answer && answer.label !== '' ? answer.label : null,
        cancelled: cancelledCard || answer?.cancelled === true || (finished && !answer),
      })
    }
  }

  const drafts = (Array.isArray(records) ? records : []).map(row => ({ kind: 'draft', row }))
  if (questions.length === 0 && drafts.length === 0) return null

  return {
    root: rootEntry
      ? { kind: 'root', text: clip(rootEntry.text, ROOT_TEXT_LIMIT), fullText: text(rootEntry.text).trim() }
      : null,
    questions,
    drafts,
    summary: {
      asked: questions.length,
      answered: questions.filter(question => question.answerLabel !== null).length,
      drafts: drafts.length,
      imported: drafts.filter(draft => Boolean(draft.row?.importedAt)).length,
    },
  }
}
