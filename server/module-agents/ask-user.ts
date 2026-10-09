/**
 * 需求会话的提问卡工具（ask_user）。
 *
 * 为什么放在 module-agents：模块会话以 noExtensions 隔离启动（用户级扩展进不来），
 * 而提问卡只能由会话内工具经 ctx.ui 发起——所以这个口子必须由装配线在会话里提供，
 * 不能依赖扩展。本文件只做逐题提问与回收答案，不碰任何领域状态。
 * 体量约定：单一职责、≤400 行；提问卡的渲染链路在前端 QuestionComposer。
 */
import { Type, type Static } from 'typebox';
import type { AgentToolResult, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

export const ASK_USER_TOOL_NAME = 'ask_user';

/** 通道不可用时的降级回执：模型应改用正文编号清单，而不是在这里等待。 */
const NO_UI_FALLBACK = {
  needsFallback: true,
  reason: '当前会话没有提问通道，请改用正文编号清单',
} as const;

const ASK_USER_PARAMETERS = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 32, description: '题目短标识，例如 Q1' }),
    question: Type.String({ minLength: 1, maxLength: 300, description: '一句话写清问题，以及它影响哪个决定' }),
    choices: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ minLength: 1, maxLength: 80, description: '选项文本，用户点击该选项即作答' }),
      description: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: '该选项的取舍说明，随选项一起显示' })),
    }, { additionalProperties: false }), { minItems: 2, maxItems: 8, description: '给出选项则用户点击作答；省略则让用户自由输入' })),
    placeholder: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: '自由输入时的提示文本' })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
}, { additionalProperties: false });

type AskUserParams = Static<typeof ASK_USER_PARAMETERS>;
type AskUserQuestion = AskUserParams['questions'][number];
type AskUserChoice = NonNullable<AskUserQuestion['choices']>[number];

export interface AskUserAnswer {
  id: string;
  question: string;
  /** 用户给出的答案；取消时为 null。 */
  answer: string | null;
  cancelled?: boolean;
}

export interface AskUserResult {
  answers: AskUserAnswer[];
  allAnswered: boolean;
}

export interface AskUserFallback {
  needsFallback: true;
  reason: string;
}

/**
 * details 除自描述结果外，还要兼容前端转写提问卡的载荷约定
 * （src/lib/ask-card.ts：批量答案按 id 配对，value/label 展示），
 * 这样历史会话里提问以「提问 · n/m 已回答」折叠卡呈现，而不是裸工具卡。
 */
export interface AskUserCardAnswers {
  answers: Array<{ id: string; value: string; label: string }>;
}

export interface AskUserCardCancelled {
  cancelled: true;
}

export type AskUserDetails = AskUserResult | AskUserFallback | AskUserCardAnswers | AskUserCardCancelled;

/** 展示文本给用户看（含取舍说明），答案回写成干净的 label。 */
function choiceLabels(choices: readonly AskUserChoice[]): string[] {
  return choices.map((choice) => choice.description === undefined || choice.description === ''
    ? choice.label
    : `${choice.label} —— ${choice.description}`);
}

/** 客户端可能回传选项文本或选项序号；映射不中时原样保留用户的回答。 */
function resolveChoiceIndex(value: string, labels: readonly string[]): number {
  const exact = labels.indexOf(value);
  if (exact >= 0) return exact;
  const ordinal = Number(value.trim());
  return Number.isInteger(ordinal) && ordinal >= 0 && ordinal < labels.length ? ordinal : -1;
}

/**
 * 取消在本桥接层有两种表现：select 取消会 reject（见 pi 的扩展 UI 桥），
 * input/select 取消返回 undefined。两者都按取消处理——不悬挂，也不算答案。
 */
async function askWithoutThrowing(run: () => Promise<string | undefined>): Promise<string | undefined> {
  try { return await run(); } catch { return undefined; }
}

function cancelledAnswer(question: AskUserQuestion): AskUserAnswer {
  return { id: question.id, question: question.question, answer: null, cancelled: true };
}

async function askOneQuestion(
  ctx: ExtensionToolContext,
  question: AskUserQuestion,
  signal: AbortSignal | undefined,
): Promise<AskUserAnswer> {
  if (signal?.aborted) return cancelledAnswer(question);
  const choices = question.choices ?? [];
  if (choices.length > 0) {
    const labels = choiceLabels(choices);
    const rendered = await askWithoutThrowing(() => ctx.ui.select(question.question, labels, { signal }));
    if (rendered === undefined) return cancelledAnswer(question);
    const index = resolveChoiceIndex(rendered, labels);
    const picked = index >= 0 ? choices[index] : undefined;
    return { id: question.id, question: question.question, answer: picked === undefined ? rendered : picked.label };
  }
  const rendered = await askWithoutThrowing(() => ctx.ui.input(question.question, question.placeholder, { signal }));
  if (rendered === undefined) return cancelledAnswer(question);
  return { id: question.id, question: question.question, answer: rendered };
}

function noUiResult(): AgentToolResult<AskUserFallback> {
  return {
    content: [{ type: 'text', text: JSON.stringify(NO_UI_FALLBACK) }],
    details: NO_UI_FALLBACK,
  };
}

export function createAskUserTool(): ToolDefinition {
  return {
    name: ASK_USER_TOOL_NAME,
    label: '提问卡片',
    description: '把需要用户拍板的关键缺口作为提问卡发出，用户逐题点击选项或输入作答；一次一批（至多 6 题）。返回各题答案与 allAnswered；用户取消的题 answer 为 null、cancelled 为 true，剩余题目不再询问。通道不可用时返回 needsFallback:true，此时改用正文编号清单继续。',
    promptSnippet: 'ask_user: 关键决策点优先用提问卡，一次一批（至多 6 题）；选择型问题给 2-4 个带取舍说明的选项，开放型问题不设选项让用户自行输入。返回 needsFallback、被取消或用户改用文字回应时，把剩余待对齐项退回正文编号清单。纯讨论或可用合理假设推进的小偏好不用卡片。',
    parameters: ASK_USER_PARAMETERS,
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      // 没有提问通道时必须同步降级：挂起等待会让离线会话卡死。
      if (!ctx.hasUI) return noUiResult();
      // SDK 已按 schema 校验参数，这里只做类型收窄。
      const { questions } = rawParams as AskUserParams;
      const answers: AskUserAnswer[] = [];
      for (const question of questions) {
        const answer = await askOneQuestion(ctx, question, signal);
        answers.push(answer);
        if (answer.cancelled === true) break;
      }
      const allAnswered = answers.length === questions.length
        && answers.every((answer) => answer.answer !== null);
      const data: AskUserResult = { answers, allAnswered };
      // details 给转写提问卡：只回已作答的题；一题都没答上（含取消）按整卡取消呈现。
      const cardAnswers = answers
        .filter((answer): answer is AskUserAnswer & { answer: string } => answer.answer !== null)
        .map(answer => ({ id: answer.id, value: answer.answer, label: answer.answer }));
      const cardDetails: AskUserCardAnswers | AskUserCardCancelled = cardAnswers.length > 0
        ? { answers: cardAnswers }
        : { cancelled: true };
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: cardDetails };
    },
  };
}
