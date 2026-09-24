/**
 * composer 那一层：状态条/挂件条、任务面板、排队消息 dock、输入框（含空会话时的
 * 工作区/分支 chip）、被问问题时的问答面，以及输入框下方的挂件条与空白垫。
 *
 * 这一层的次序就是 dsh 的 dock 次序（任务面板在最上，其次排队，再往下是 composer
 * 卡），所以它们合成一个组件、按原顺序渲染；外层 flex 列直接吃这一片子节点，
 * fragment 不产生额外 DOM。
 */
import { Flexbox } from '@lobehub/ui';

import { BranchSelect } from '../components/BranchSelect';
import { Composer } from '../components/Composer';
import { QuestionComposer } from '../components/QuestionComposer';
import { QueueDock } from '../components/QueueDock';
import { StatusStrip, WidgetStrip } from '../components/StatusStrip';
import { TaskPanel } from '../components/TaskPanel';
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher';
import type { PiSessionApi } from '../lib/usePiSession';
import type { TodoItem } from '../lib/todos';
import type { ModelCatalog } from '../shared/model-catalog';
import type { ToolPreset } from '../shared/tool-presets';
import type { PendingDialog } from '../lib/usePiSession';

export interface ComposerDockProps {
  /** 会话本体：状态条、队列、问答面都读它。 */
  session: PiSessionApi;
  /** composer 用的 api：同一个会话，但发送/模型写入走上层的守门版本。 */
  api: PiSessionApi;
  catalog: ModelCatalog | null;
  toolPreset: ToolPreset | null;
  onToolPresetChange: (preset: ToolPreset) => void;
  contextPercent: number | null;
  /** 空转写：composer 上方还带工作区/分支 chip。 */
  empty: boolean;
  cwd: string;
  /** 可选工作区路径（chip 的菜单项）。 */
  workspacePaths: string[];
  home: string | undefined;
  onPickWorkspace: (path: string) => void;
  onBrowseWorkspace: () => void;
  todos: readonly TodoItem[];
  pendingQuestion: PendingDialog | null;
}

export function ComposerDock({
  session,
  api,
  catalog,
  toolPreset,
  onToolPresetChange,
  contextPercent,
  empty,
  cwd,
  workspacePaths,
  home,
  onPickWorkspace,
  onBrowseWorkspace,
  todos,
  pendingQuestion,
}: ComposerDockProps) {
  return (
    <>
      <Flexbox paddingInline={20} style={{ flex: 'none', minWidth: 0, maxWidth: 940, margin: '0 auto', width: '100%' }}>
        <WidgetStrip widgets={session.widgets} placement="aboveEditor" />
        <StatusStrip api={session} />
      </Flexbox>

      {/* The task panel is the topmost dock entry — dsh's ordering, where the
          todo dock registers at order 0, above the queue and the composer
          card. Same column as the composer layer (940px, 20px gutters); the
          card returns null on an empty list, so the layer costs no height
          when there is nothing to show. */}
      <div style={{ flex: 'none', minWidth: 0, padding: '0 20px', maxWidth: 940, margin: '0 auto', width: '100%' }}>
        <TaskPanel todos={todos} />
      </div>

      {/* The dock hangs above the composer card, outside the box the question
          replaces: a message queued behind a running turn must stay visible
          and steerable while the agent is also waiting on an answer. */}
      <div style={{ flex: 'none', minWidth: 0, padding: '0 20px', maxWidth: 940, margin: '0 auto', width: '100%' }}>
        <QueueDock
          items={session.transcript.queued.pending}
          running={session.transcript.running}
          onSteer={(id) => session.updateQueue(id, { kind: 'steer' }).then(() => undefined)}
          onEdit={(id, next) => session.updateQueue(id, { kind: 'edit', text: next }).then(() => undefined)}
          onRemove={(id) => session.updateQueue(id, { kind: 'remove' }).then(() => undefined)}
        />
      </div>

      {/* The question takes the composer's seat — dsh's `conversation.composer`
          chain, where an elected entry overlays the bar. The bar itself stays
          mounted behind `display: none` rather than unmounting: a draft being
          written when the agent asks something has to survive the question. */}
      <div style={{ display: pendingQuestion === null ? 'contents' : 'none' }}>
        <Composer
          api={api}
          catalog={catalog}
          toolPreset={toolPreset}
          onToolPresetChange={onToolPresetChange}
          /* Nothing to send to yet is not a reason to lock the composer: the
             first send creates the session (see guardedPrompt). */
          disabled={false}
          contextPercent={contextPercent}
          /* The workspace/branch chips answer a question a blank session still
             has — where does this run. Once a conversation exists, the workspace
             is that session's own fact and dsh drops the accessory row too, so
             the composer below a transcript is just the input and its controls. */
          contextBar={empty ? (
            <>
              <WorkspaceSwitcher
                cwd={cwd}
                workspaces={workspacePaths}
                {...(home === undefined ? {} : { home: home })}
                onPick={onPickWorkspace}
                onBrowse={onBrowseWorkspace}
              />
              {cwd.length > 0 && (
                <BranchSelect
                  cwd={cwd}
                  running={session.transcript.running}
                  onError={(message) => { session.notify('error', '切换分支失败', message); }}
                />
              )}
            </>
          ) : undefined}
        />
      </div>
      {pendingQuestion !== null && (
        <QuestionComposer
          /* Keyed to the request: the surface must not carry a previous
             question's text into the next one. */
          key={pendingQuestion.request.id}
          dialog={pendingQuestion}
          onRespond={(body) => void session.respondToDialog(pendingQuestion.request.id, body)}
        />
      )}
      <Flexbox paddingInline={20} style={{ maxWidth: 940, margin: '0 auto', width: '100%' }}>
        <WidgetStrip widgets={session.widgets} placement="belowEditor" />
      </Flexbox>
      {empty && <div style={{ flex: 1, minHeight: 0 }} aria-hidden="true" />}
    </>
  );
}
