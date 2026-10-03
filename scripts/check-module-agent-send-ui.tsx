import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AIPanel from '../src/workbench-app/shell/AIPanel.jsx';

const renderBusyPanel = (pending: Array<{ id: string; text: string; imageCount: number }>) => renderToStaticMarkup(h(AIPanel, {
  title: '模块 Agent',
  subtitle: '模块 Agent',
  transcript: {
    entries: [], streamingEntryId: null, running: true, compacting: false, retrying: null,
    queued: { steering: [], followUp: [], pending },
    lastError: null, title: null, turnSeq: 1, activeTurn: 1, turnProcesses: {},
  },
  assistRows: [],
  busy: true,
  status: 'live',
  modelName: 'offline fixture',
  themeMode: 'light',
  stepsMode: 'standard',
  sendDisabled: false,
  supportsImages: true,
  draft: '正在运行时仍可发送的补充内容',
  onDraftChange: () => {},
  onSend: () => Promise.resolve(true),
  onStop: () => Promise.resolve(),
  stopping: false,
  onUpdateQueue: () => Promise.resolve(),
  onNew: () => {},
  canNewConversation: false,
  onRetry: () => {},
  onRefreshData: () => {},
  onAction: () => {},
  embedded: true,
}));

function elementByTestId(html: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<[^>]*data-testid="${escaped}"[^>]*>`).exec(html);
  assert.ok(match, `SSR markup must include ${id}`);
  return match[0]!;
}

const oneQueued = renderBusyPanel([{ id: 'queue-1', text: '队列内容', imageCount: 1 }]);
assert.match(oneQueued, /data-testid="module-agent-queue"/);
assert.match(oneQueued, /队列内容/);
assert.match(oneQueued, /data-testid="module-agent-input"/);
assert.match(oneQueued, /data-testid="module-agent-send-actions"/);
assert.match(oneQueued, /data-testid="module-attach-input"/);
assert.match(oneQueued, /data-testid="queue-edit"/);
assert.match(oneQueued, /data-testid="queue-remove"/);
assert.match(oneQueued, /data-testid="queue-steer"/);
assert.match(oneQueued, /data-testid="module-agent-stop"/);
assert.match(oneQueued, /data-testid="module-agent-send"/);
assert.match(oneQueued, /data-testid="module-agent-steer"/);
for (const id of ['module-agent-input', 'module-agent-send', 'module-agent-steer', 'module-agent-stop', 'queue-edit', 'queue-remove', 'queue-steer']) {
  assert.doesNotMatch(elementByTestId(oneQueued, id), /\sdisabled(?:="")?(?:\s|>)/,
    `${id} must remain enabled during a running Module Agent turn`);
}
assert.match(elementByTestId(oneQueued, 'queue-steer'), /aria-label="插话发送"/);
assert.match(elementByTestId(oneQueued, 'module-agent-steer'), /插话发送/);
assert.match(elementByTestId(oneQueued, 'module-agent-send'), /排队发送/);

const manyQueued = renderBusyPanel([
  { id: 'queue-1', text: '排队一', imageCount: 0 },
  { id: 'queue-2', text: '排队二', imageCount: 2 },
]);
assert.match(manyQueued, /data-testid="queue-collapse"[^>]*aria-expanded="false"/,
  'multiple queued prompts should remain in the compact queue summary');
assert.match(manyQueued, /2 条排队消息/);
const newSession = elementByTestId(manyQueued, 'module-agent-new');
assert.match(newSession, /disabled=""/, 'queued work must prevent replacing the current session');

console.log('PASS module Agent SSR: busy send, explicit steer, stop, attachments and queued-row controls remain available');
