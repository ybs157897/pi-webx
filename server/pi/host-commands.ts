/**
 * 命令分发：浏览器 `POST /command` 词汇到 pi 会话调用的唯一入口。
 *
 * `handleCommand` 是幂等闸门（requestId 去重），`dispatchCommand` 是那个巨大的
 * switch——每个 case 返回一个 `PiRpcResponse`，错误向上传播给 `handleCommand`
 * 释放 requestId 并回填关联 id。状态投影（state/stats/thinkingLevels/commands）
 * 是 switch 的只读支撑，同住这里。
 */
import type { ImageContent, ModelThinkingLevel } from '@earendil-works/pi-ai';
import { resolveCliModel } from '@earendil-works/pi-coding-agent';
import type {
  PiCommandEnvelope,
  PiRpcResponse,
  PiSessionState,
  PiSessionStats,
} from '../../src/shared/protocol';
import { prepareIncomingImages } from '../attachment/store';
import { validateToolSelection } from '../tool-selection';
import {
  asModel,
  errorText,
  fail,
  isAlreadyProcessing,
  ok,
  PROMPT_COMMANDS,
  type HostedSession,
  type HostInternals,
} from './host-contract';
import { broadcastError, broadcastQueue, enqueue, queueView, updateQueue } from './host-events';
import { refreshSubagentTool } from './host-teams';
import { resetInPlace } from './host-session-assembly';

/**
 * 一个命令的完整路径：按 id 找会话、幂等去重、分发、失败时释放 requestId 并
 * 回填关联 id。
 */
export async function handleCommand(
  host: HostInternals,
  id: string,
  command: PiCommandEnvelope,
): Promise<PiRpcResponse> {
  const hosted = host.sessions.get(id);
  if (!hosted) return fail(command.type, 'unknown session', command.id);
  if (!hosted.alive) return fail(command.type, 'session is not running', command.id);
  hosted.lastSeen = Date.now();

  // Business-level idempotency, independent of the HTTP transport: a prompt
  // the host has already seen (pending or settled) is acknowledged without
  // being submitted to pi again — a retried submit must not double-send.
  const requestId = command.id;
  const idempotent = requestId !== undefined && PROMPT_COMMANDS.has(command.type);
  if (idempotent && !hosted.promptRequests.add(requestId)) {
    return ok(command.type, { accepted: true, deduplicated: true }, requestId);
  }

  try {
    const response = await dispatchCommand(host, hosted, command);
    return command.id === undefined ? response : { ...response, id: command.id };
  } catch (error) {
    if (idempotent && requestId !== undefined) hosted.promptRequests.forget(requestId);
    return fail(command.type, errorText(error), command.id);
  }
}

async function dispatchCommand(
  host: HostInternals,
  hosted: HostedSession,
  command: PiCommandEnvelope,
): Promise<PiRpcResponse> {
  const session = hosted.session;

  // Every case returns; errors propagate to handleCommand(), which releases the
  // requestId and echoes the correlation id on the response.
  switch (command.type) {
      case 'prompt': {
        if (hosted.preparing) return fail(command.type, '正在准备上一轮，请稍后再发送。');
        if (command.images?.length && !session.model?.input.includes('image')) {
          return fail(command.type, '当前模型未启用图片输入，请在模型设置中启用或选择支持图片的模型。');
        }
        /**
         * 投递方式由**服务端自己的运行状态**决定，不用客户端的「正在执行」。
         *
         * 客户端的 running 是派生视图（transcript + 快照），轮次收尾的一瞬间会
         * 落后于 pi 的 `isStreaming`。DSH 的立场是服务端从不因为「正忙」而拒绝
         * 一条用户消息：忙 + 未指定 → 进待发送队列（`busyEnter` 默认就是 queue），
         * 忙 + 显式 steer → 立刻插话进当前这轮，空闲 → 正常开一轮。
         * 客户端因此不需要猜服务端的状态，也不会因为猜错而看到一条红色报错。
         */
        /**
         * 附上的图片先规范化再交给 pi。
         *
         * 客户端给的可能是任何东西（手机直出的 HEIC 转 PNG、带 EXIF 方向的 JPEG、
         * 超大截图），而网关只收 WebP/JPEG 且会拿 `unsupported image` 把一张合法 PNG
         * 挡回来。规范化同时把字节落进内容寻址的附件库，pi 于是把**规范化后**的图写进
         * 会话日志——后面每一轮历史里带的就是这份，不需要再处理一次。
         *
         * 这一步排在「排队还是直接发」之前：排队那条路 drain 时同样把 `item.images`
         * 交给 pi，所以两条路都得拿到规范化后的那份字节。
         */
        let prepared: Awaited<ReturnType<typeof prepareIncomingImages>>;
        try {
          prepared = await prepareIncomingImages(command.images);
        } catch (error) {
          if (command.id !== undefined) hosted.promptRequests.forget(command.id);
          return fail(command.type, errorText(error), command.id);
        }
        if (command.streamingBehavior === undefined && session.isStreaming) {
          const queued = enqueue(host, hosted, command.message, prepared.images as unknown as ImageContent[]);
          return ok(command.type, { accepted: true, deliveredAs: 'queue', queuedId: queued.id });
        }
        // 空闲时忽略显式 steer：pi 的 steer 只在当前轮里有投递窗口，空闲会话上
        // 它会一直躺在队列里等一个永远不会到来的下一轮。
        const behavior = session.isStreaming ? command.streamingBehavior : undefined;
        hosted.preparing = true;
        // Before the request is built: an enabled/disabled edit made since the
        // last turn has to be visible to this turn's tool schema, and the tool
        // must not be offered at all when nothing is enabled.
        await refreshSubagentTool(host, hosted);
        /** Why the preflight said no — the client needs it to tell a race from a real refusal. */
        let reason: string | null = null;
        const accepted = new Promise<boolean>((resolve) => {
          void session
            .prompt(command.message, {
              ...(prepared.images.length > 0
                ? { images: prepared.images as unknown as import('@earendil-works/pi-ai').ImageContent[] }
                : {}),
              ...(behavior ? { streamingBehavior: behavior } : {}),
              preflightResult: resolve,
            })
            .catch((error: unknown) => {
              reason = errorText(error);
              // 「已经有一轮在跑」是这一层的竞态，不是用户的错：下面会把它
              // 收进待发送，所以不该先给界面推一条红色报错。
              if (!(command.streamingBehavior === undefined && isAlreadyProcessing(reason))) {
                broadcastError(host, hosted, reason);
              }
            });
        });
        const success = await accepted.finally(() => {
          hosted.preparing = false;
        });
        /**
         * 竞态自愈落在服务端：判定「正忙」用的是 pi 自己的 `isStreaming`，两者
         * 之间仍有一个极窄的窗口，此时 SDK 会抛 `Agent is already processing`。
         * 用户的本意是「接着说」，所以排进待发送而不是回一条错误。
         */
        if (!success && command.streamingBehavior === undefined && reason !== null && isAlreadyProcessing(reason)) {
          if (command.id !== undefined) hosted.promptRequests.forget(command.id);
          const queued = enqueue(host, hosted, command.message, prepared.images as unknown as import('@earendil-works/pi-ai').ImageContent[]);
          return ok(command.type, { accepted: true, deliveredAs: 'queue', queuedId: queued.id });
        }
        // A rejected preflight never becomes a durable user message: release
        // the requestId so retrying the same submit re-attempts it.
        if (!success && command.id !== undefined) hosted.promptRequests.forget(command.id);
        /**
         * `accepted: false` 一定是「这一轮起不来」。把原因一起带回去，客户端才能
         * 分辨竞态与真正的拒绝——少了这个字段，前端只能猜。
         */
        return ok(command.type, {
          accepted: success,
          ...(success || reason === null ? {} : { reason }),
          ...(behavior === undefined ? {} : { deliveredAs: behavior }),
        });
      }
      case 'steer':
        await session.steer(command.message);
        return ok(command.type);
      case 'follow_up':
        await refreshSubagentTool(host, hosted);
        await session.followUp(command.message);
        return ok(command.type);
      case 'update_queue': {
        const failure = await updateQueue(host, hosted, command.id, command.action);
        return failure === null ? ok(command.type) : fail(command.type, failure);
      }
      case 'abort':
        // An extension awaiting a dialog would otherwise keep waiting for an
        // answer to a turn the user just stopped.
        for (const dialog of hosted.pendingDialogs.values()) {
          dialog.respond({ type: 'extension_ui_response', id: dialog.request.id, cancelled: true });
        }
        await session.abort();
        return ok(command.type);
      case 'clear_queue': {
        hosted.queue = [];
        broadcastQueue(host, hosted);
        return { type: 'response', command: command.type, success: true, data: session.clearQueue() };
      }
      case 'new_session': {
        await resetInPlace(host, hosted);
        return { type: 'response', command: command.type, success: true, data: { cancelled: false } };
      }
      case 'get_state':
        return { type: 'response', command: command.type, success: true, data: stateOf(hosted) };
      case 'get_messages': {
        const messages = session.messages;
        const streamingMessage = session.agent.state.streamingMessage;
        const running = session.isStreaming;
        // Captured after the list was read: pi appends to its log and emits
        // the event in the same synchronous turn, so everything the snapshot
        // reflects is already journaled and covered by `throughSeq`.
        const throughSeq = hosted.journal.latestSeq;
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: {
            messages,
            throughSeq,
            running,
            streamingMessage,
            // Handed back so a reconnecting client restores the prompts an
            // extension is still waiting on, with the time each has left rather
            // than a fresh full timeout.
            pendingDialogs: [...hosted.pendingDialogs.values()].map(({ request, createdAt }) => ({
              ...request,
              ...(request.timeout === undefined
                ? {}
                : { timeout: Math.max(1, request.timeout - (Date.now() - createdAt)) }),
            })),
            // Same reason as the dialogs: the wait list lives in memory and the
            // journal frames that announced it are already behind `throughSeq`
            // for a client that is opening the session now.
            queue: queueView(hosted),
          },
        };
      }
      case 'set_model': {
        const runtime = await host.runtime();
        const resolved = resolveCliModel({
          cliModel: `${command.provider}/${command.modelId}`,
          modelRuntime: runtime,
        });
        if (resolved.error) return fail(command.type, resolved.error);
        if (!resolved.model) return fail(command.type, 'model not found');
        await session.setModel(resolved.model);
        return { type: 'response', command: command.type, success: true, data: asModel(session.model) };
      }
      case 'cycle_model': {
        const result = await session.cycleModel();
        return { type: 'response', command: command.type, success: true, data: result ?? null };
      }
      case 'get_available_models': {
        const runtime = await host.runtime();
        const models = await runtime.getAvailable();
        return { type: 'response', command: command.type, success: true, data: { models } };
      }
      case 'set_thinking_level':
        session.setThinkingLevel(command.level);
        return ok(command.type);
      case 'cycle_thinking_level':
        return { type: 'response', command: command.type, success: true, data: { level: session.cycleThinkingLevel() ?? session.thinkingLevel } };
      case 'get_available_thinking_levels':
        return { type: 'response', command: command.type, success: true, data: { levels: thinkingLevels(hosted) } };
      case 'set_steering_mode':
        session.setSteeringMode(command.mode);
        return ok(command.type);
      case 'set_follow_up_mode':
        session.setFollowUpMode(command.mode);
        return ok(command.type);
      case 'compact':
        return { type: 'response', command: command.type, success: true, data: await session.compact(command.customInstructions) };
      case 'get_session_stats': {
        // The context-window percentage is this command's answer, so a config
        // edited under a running session must be picked up before it is computed.
        await host.syncModelConfig();
        return { type: 'response', command: command.type, success: true, data: statsOf(hosted) };
      }
      case 'set_session_name':
        session.setSessionName(command.name);
        hosted.sessionName = command.name;
        return ok(command.type);
      case 'get_tools': {
        // pi-web's shape: every tool, each flagged with whether it is active, so
        // a panel can show what a preset turned off.
        const active = new Set(hosted.session.getActiveToolNames());
        return {
          type: 'response',
          command: command.type,
          success: true,
          data: {
            tools: hosted.session.getAllTools().map((tool) => ({
              name: tool.name,
              description: tool.description,
              active: active.has(tool.name),
            })),
            selection: hosted.toolSelection ?? hosted.session.getActiveToolNames(),
          },
        };
      }
      case 'set_tools': {
        const requested = validateToolSelection((command as unknown as { toolNames?: unknown }).toolNames);
        if (requested === undefined) {
          return fail(command.type, 'toolNames 必须是内置工具名数组');
        }
        host.setToolSelection(hosted, requested, { persist: true });
        return { type: 'response', command: command.type, success: true, data: { toolNames: requested } };
      }
      case 'get_commands':
        return {
          type: 'response',
          command: command.type,
          success: true,
          // The merged list: extension commands, prompt templates and skills.
          // pi built it while loading resources, and its runtime is the only
          // public accessor — the runner that assembles it is private to
          // `createAgentSession`.
          data: { commands: commandsOf(host, hosted) },
        };
      case 'extension_ui_response': {
        const answered = host.respondToDialog(command.id, {
          type: 'extension_ui_response',
          id: command.id,
          ...(command.value === undefined ? {} : { value: command.value }),
          ...(command.confirmed === undefined ? {} : { confirmed: command.confirmed }),
          ...(command.cancelled === undefined ? {} : { cancelled: command.cancelled }),
        });
        if (!answered) return fail(command.type, `no extension dialog is waiting on id ${command.id}`);
        return ok(command.type);
      }
      case 'set_auto_compaction':
      case 'set_auto_retry':
      case 'export_html':
      case 'bash':
      case 'abort_bash':
        return fail(command.type, `${command.type} is not supported by the SDK host yet`);
      default:
        return fail(command.type, `unknown command: ${(command as { type: string }).type}`);
    }
  }

/**
 * The session's slash commands, as the browser's command menu needs them.
 *
 * Sending `/name args` as a prompt is enough to run one: `session.prompt`
 * dispatches extension commands and expands skill and prompt-template commands
 * by default, so this list only has to be accurate, not executable here.
 */
function commandsOf(
  host: HostInternals,
  hosted: HostedSession,
): Array<{
  name: string;
  description?: string;
  source?: string;
}> {
  try {
    const commands = hosted.extensionsResult.runtime.getCommands();
    return commands.map((entry) => ({
      name: entry.name,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
    }));
  } catch (error) {
    broadcastError(host, hosted, `无法读取斜杠命令列表：${errorText(error)}`);
    return [];
  }
}

function stateOf(hosted: HostedSession): PiSessionState {    const { session } = hosted;
  return {
    model: asModel(session.model),
    thinkingLevel: session.thinkingLevel,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    sessionFile: session.sessionFile ?? null,
    sessionId: session.sessionId,
    sessionName: hosted.sessionName ?? undefined,
    messageCount: session.messages.length,
    pendingMessageCount: hosted.queue.length,
  };
}

function statsOf(hosted: HostedSession): PiSessionStats {
  const { session } = hosted;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  for (const message of session.messages) {
    if (message.role === 'user') userMessages += 1;
    if (message.role === 'assistant') {
      assistantMessages += 1;
      for (const block of message.content) {
        if (block.type === 'toolCall') toolCalls += 1;
      }
      const usage = message.usage;
      if (usage) {
        input += usage.input ?? 0;
        output += usage.output ?? 0;
        cacheRead += usage.cacheRead ?? 0;
        cacheWrite += usage.cacheWrite ?? 0;
        cost += usage.cost?.total ?? 0;
      }
    }
  }
  const contextWindow = session.model?.contextWindow ?? 0;
  const tokens = input + output;
  return {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? null,
    model: asModel(session.model),
    thinkingLevel: session.thinkingLevel,
    totalMessages: session.messages.length,
    userMessages,
    assistantMessages,
    toolCalls,
    totalTokens: tokens,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalCost: cost,
    contextUsage:
      contextWindow > 0
        ? { tokens, contextWindow, percent: Math.round((tokens / contextWindow) * 100) }
        : null,
  };
}

/**
 * Levels this session's model actually accepts.
 *
 * Mirrors pi's own `getSupportedThinkingLevels` (`pi-ai/dist/models.js`),
 * because it is the same function `session.setThinkingLevel` clamps against:
 * a model that does not reason supports `off` alone, and a model that does
 * supports the extended list minus every level its `thinkingLevelMap` pins to
 * `null` — with `xhigh`/`max` counted as supported only when the map names
 * them explicitly. Reporting the global vocabulary here (as this used to) told
 * the browser about levels every request would be clamped away from.
 */
function thinkingLevels(hosted: HostedSession): ModelThinkingLevel[] {
  const model = hosted.session.model as
    | { reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> }
    | undefined;
  if (model?.reasoning !== true) return ['off'];
  const levels = ([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const).filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
  return levels as unknown as ModelThinkingLevel[];
}
