import RequirementDraftCard from './DraftCard.jsx'
import { buildRequirementCanvas } from './canvas-model.js'
import './Canvas.css'

/**
 * 需求画布：把本会话的需求推进过程画成横向决策树——诉求固定为题头，提问是分叉，
 * 被选中的选项边高亮（选择题不重复渲染答案节点），自由输入/取消/等待与草稿产物向右长出；
 * 顶部一行收敛指示回答「现在在什么边界」。
 *
 * 布局用嵌套 ul/li + CSS 连接线（组织架构图写法）：问题列 + 各自的选项子列表，
 * 连接线全部由 ::before/::after 的边框画，不测量坐标也不读尺寸，
 * 所以 SSR 纯渲染即可成形。数据全部来自 canvas-model 的前端投影，不在渲染期算业务。
 */
export default function RequirementCanvas({ entries, records, dispatchedIds, busy = false, onImport, onOpenTasks }) {
  const canvas = buildRequirementCanvas({ entries, records })
  if (!canvas) {
    return <div className="req-canvas" data-testid="req-canvas" aria-label="需求画布">
      <p className="req-canvas-empty" data-testid="req-canvas-empty">还没有可画的需求脉络：发起对话，agent 提问后这里会长出分支</p>
    </div>
  }
  const { asked, answered, drafts, imported } = canvas.summary
  const converged = asked > 0 && answered === asked && drafts > 0
  return <div className="req-canvas" data-testid="req-canvas" aria-label="需求画布">
    <p className="req-canvas-summary" data-testid="req-canvas-summary">
      <span>{asked > 0 ? `已拍板 ${answered}/${asked}` : '还没有提问'} · 草稿 {drafts} 条 · 已导入 {imported}</span>
      {converged && <span className="req-canvas-converged" data-testid="req-canvas-converged">需求已收敛，可确认导入</span>}
    </p>
    <div className="req-canvas-root" data-testid="req-canvas-root" title={canvas.root?.fullText ?? ''}>
      <span className="req-canvas-root-label">诉求</span>
      <span className="req-canvas-root-text">{canvas.root ? canvas.root.text : '（未记录诉求原文）'}</span>
    </div>
    <div className="req-canvas-tree">
      <ul>
        {canvas.questions.map(question => {
          // 选择题的被选边已用 is-picked 表达结果，不再重复渲染答案节点；
          // 答案节点只留给自由输入、取消与等待三种状态。
          const pickedByChoice = question.choices.some(choice => choice.label === question.answerLabel)
          const showAnswer = question.answerLabel !== null ? !pickedByChoice : true
          return <li className="req-canvas-branch" key={`${question.runId}:${question.id}`}>
            <div className="req-canvas-question" data-testid="req-canvas-question" title={question.question}>{question.question}</div>
            <ul>
              {question.choices.map((choice, index) => <li key={`choice:${String(index)}:${choice.label}`}>
                <div className={`req-canvas-choice${question.answerLabel === choice.label ? ' is-picked' : ''}`} data-testid="req-canvas-choice" title={choice.description}>{choice.label}</div>
              </li>)}
              {showAnswer && <li>
                <div className={`req-canvas-answer${question.cancelled ? ' is-cancelled' : ''}${question.answerLabel === null && !question.cancelled ? ' is-waiting' : ''}`} data-testid="req-canvas-answer" title={question.answerLabel ?? ''}>
                  {question.answerLabel ?? (question.cancelled ? '未作答（已取消）' : '等待回答')}
                </div>
              </li>}
            </ul>
          </li>
        })}
        {canvas.drafts.map(draft => <li key={`draft:${String(draft.row?.id ?? '')}`}>
          <div className="req-canvas-draft" data-testid="req-canvas-draft">
            <RequirementDraftCard row={draft.row} dispatched={Boolean(dispatchedIds?.has?.(draft.row?.id))} busy={busy} onImport={onImport} onOpenTasks={onOpenTasks} />
          </div>
        </li>)}
      </ul>
    </div>
  </div>
}
