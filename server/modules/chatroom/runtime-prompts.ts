import { CHATROOM_MEMBER_NAMES, type ChatroomMessage, type ChatroomPublicMessage } from './contracts';

export function formatChatroomPrompt(message: ChatroomMessage, history: ChatroomPublicMessage[], options: {
  omitted?: number;
  scope?: 'discussion' | 'assignment';
  taskId?: string | null;
  assignmentId?: string | null;
} = {}): string {
  const prior = history.filter((item) => item.seq < message.seq);
  const lines = prior.map((item) => {
    const recipient = item.recipientId === null ? '群内' : `发给 ${CHATROOM_MEMBER_NAMES[item.recipientId]}`;
    const body = item.body.length > 1000 ? `${item.body.slice(0, 1000)}…（较早消息已截断）` : item.body;
    return `#${item.seq} ${item.senderId === 'user' ? '用户本人' : item.senderName} → ${recipient}: ${body}`;
  });
  const context = Object.entries(message.context ?? {}).filter(([, value]) => value !== undefined);
  const sender = message.senderId === 'user' ? '用户本人' : message.senderName;
  return [
    '你收到工作台内部聊天室的一条消息。发送者身份由服务器记录。按你的模块职责和已提供工具处理最后一条消息；需要联系其他 Agent 时使用聊天室工具。完成后给出简洁正文。',
    ...(options.scope === 'assignment' && options.taskId
      ? [`当前工作分工：任务 ${options.taskId}，分工 ${options.assignmentId}。普通回复只确认这一回合；仅在交付物完成且验证后调用 chatroom_work 明确完成任务。`] : []),
    ...(options.omitted ? [`本次仅注入最近 ${lines.length} 条增量消息；另有 ${options.omitted} 条较早群消息可通过 chatroom_read 检索。`] : []),
    ...(lines.length ? ['\n本讨论串较早的消息：', ...lines] : []),
    `\n当前消息 #${message.seq}，来自 ${sender}：\n${message.body}`,
    ...(context.length ? [`\n服务端关联记录：${JSON.stringify(Object.fromEntries(context))}`] : []),
  ].join('\n');
}

/** Fan-out gate: every enabled member judges an unaddressed publication before anyone works on it. */
export function formatClaimPrompt(message: ChatroomMessage, history: ChatroomPublicMessage[]): string {
  const prior = history.filter((item) => item.seq < message.seq).slice(-10);
  const lines = prior.map((item) => `#${item.seq} ${item.senderId === 'user' ? '用户本人' : item.senderName}: ${item.body.slice(0, 400)}`);
  const context = Object.entries(message.context ?? {}).filter(([, value]) => value !== undefined);
  const sender = message.senderId === 'user' ? '用户本人' : message.senderName;
  return [
    '内部聊天室刚发布了一条未点名任何成员的群广播，你是订阅成员之一。请只依据自己的模块职责判断这条广播是否应该由你处理并公开回复：',
    '- 只是收悉、感谢、总结汇报，或明显属于其他成员职责时，不要认领。',
    '- 认领后你将在独立的工作会话着手处理；本判断阶段不要调用任何工具。',
    '只输出一行 JSON：{"claim": true, "reason": "简短理由"} 或 {"claim": false, "reason": "简短理由"}。',
    ...(lines.length ? ['\n本话题最近的消息：', ...lines] : []),
    `\n当前广播 #${message.seq}，来自 ${sender}：\n${message.body}`,
    ...(context.length ? [`\n服务端关联记录：${JSON.stringify(Object.fromEntries(context))}`] : []),
  ].join('\n');
}

export type ClaimVerdict = 'claim' | 'pass' | 'unreadable';

export function parseClaimVerdict(text: string): ClaimVerdict {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    const claim = (parsed as { claim?: unknown }).claim;
    return typeof claim === 'boolean' ? (claim ? 'claim' : 'pass') : 'unreadable';
  } catch {
    return 'unreadable';
  }
}
