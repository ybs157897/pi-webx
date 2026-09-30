import { Type } from 'typebox';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentId } from '../../module-agents/contracts';
import type { ChatroomService } from './service';
import type { ChatroomSendInput } from './contracts';
import { publicMessage } from './store';

export const CHATROOM_TOOL_NAMES: Readonly<Record<string, string>> = {
  'chatroom.send': 'chatroom_send',
  'chatroom.read': 'chatroom_read',
};

function result(data: unknown, maxChars: number): AgentToolResult<unknown> {
  const text = JSON.stringify(data);
  return {
    content: [{ type: 'text', text: text.length <= maxChars ? text : JSON.stringify({ truncated: true, message: '结果过长，请缩小读取范围' }) }],
    details: { data },
  };
}

const recipient = Type.Union([
  Type.Literal('requirements'), Type.Literal('assistant'), Type.Literal('codes'), Type.Literal('logs'),
]);

export function createChatroomTools(deps: {
  service: ChatroomService;
  agentId: AgentId;
  limits: { maxToolOutputChars: number };
}): ToolDefinition[] {
  const max = deps.limits.maxToolOutputChars;
  return [
    {
      name: CHATROOM_TOOL_NAMES['chatroom.send']!,
      label: '发送内部群消息',
      description: '以当前 Agent 身份发送正文到内部聊天室。正文可用 @成员点名一位同事并持久排队；也可用 to 指定收件人，服务器会在正文前补上可见的 @姓名。无 @ 且无 to 时是群发布：推送给其他所有启用成员，由各成员按职责自行认领处理。重试同一条须复用 entryKey。业务引用由服务器核对来源会话。',
      promptSnippet: 'chatroom_send: 在内部群发正文，使用 @需求管理/@代码开发/@我的助理/@日志查询 或 to 指定接力 Agent；无 @ 的群发布由其他成员自行认领；entryKey 用稳定唯一值。需求和待办引用只传当前会话有权使用的记录。',
      parameters: Type.Object({
        to: Type.Optional(recipient),
        body: Type.String({ minLength: 1, maxLength: 12000, description: '公开展示的消息正文，不包含思考过程' }),
        entryKey: Type.String({ minLength: 1, maxLength: 200, description: '当前会话内本条消息的稳定幂等标识' }),
        requirementId: Type.Optional(Type.String()),
        expectedUpdatedAt: Type.Optional(Type.String()),
        taskIds: Type.Optional(Type.Array(Type.String({ description: '研发向助理回报时必须显式填写确已完成的关联待办 ID；未完成传 []' }), { maxItems: 40 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error('当前会话已中止，不能发送群消息');
        const sessionId = ctx.sessionManager.getSessionId();
        const message = deps.service.send(deps.agentId, sessionId, params as ChatroomSendInput);
        return result({ message: publicMessage(message) }, max);
      },
    },
    {
      name: CHATROOM_TOOL_NAMES['chatroom.read']!,
      label: '读取内部群消息',
      description: '按持久顺序号读取内部聊天室公开正文；after 为上次返回的 nextCursor。',
      promptSnippet: 'chatroom_read: 按 after/limit 读取内部群的公开消息；没有内部上下文或思考内容。',
      parameters: Type.Object({
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return result(deps.service.read(params as { after?: number; limit?: number }), max);
      },
    },
  ];
}
