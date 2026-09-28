/** Shared Skill/MCP rendering, including streamed and replayed failures. */
import assert from 'node:assert/strict';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolRunView } from '../src/components/ToolRunView';
import { TranscriptView } from '../src/components/TranscriptView';
import { capabilityCall } from '../src/lib/capability-call';
import { applyPiEvent, applySnapshot, createTranscript } from '../src/lib/transcript';
import { completedProcessSpec, liveProcessSpec } from '../src/lib/transcript/presentation';
import type { PiAgentMessage, PiEvent } from '../src/shared/protocol';
import type { ToolRun, ToolResultEntry, TranscriptState } from '../src/shared/transcript';

const run = (over: Partial<ToolRun> = {}): ToolRun => ({
  toolCallId: 'cap-1', toolName: 'skills_read', args: { name: 'log-analysis' },
  status: 'running', output: '', startedAt: 1, ...over,
});
const entry = (value: ToolRun): ToolResultEntry => ({ kind: 'toolResult', id: value.toolCallId, at: 1, run: value });
const renderRun = (value: ToolRun) => renderToStaticMarkup(h(ConfigProvider, { motion }, h(ToolRunView, { run: value })));
const within = (html: string, testId: string) => {
  const at = html.indexOf(`data-testid="${testId}"`);
  assert.ok(at >= 0, `${testId} must be rendered`);
  const start = html.lastIndexOf('<', at);
  const tag = /^<(\w+)/.exec(html.slice(start))![1]!;
  let depth = 0;
  for (const match of html.slice(start).matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, start + match.index! + match[0].length);
  }
  throw new Error(`Unclosed ${testId}`);
};
const renderTranscript = (value: ToolRun, mode: 'compact' | 'standard' | 'detailed' | 'verbose', settled = false) => {
  const transcript: TranscriptState = {
    ...createTranscript(),
    entries: [
      { kind: 'user', id: 'u', at: 0, text: '查询日志', imageCount: 0 }, entry(value),
      ...(settled ? [{ kind: 'assistant' as const, id: 'answer', at: 3, text: '结果正文', thinking: '', streaming: false, tools: [] }] : []),
    ],
    running: !settled, turnSeq: 1,
    activeTurn: settled ? null : { id: 1, startId: 'u' },
    turnProcesses: settled ? { 1: { hiddenIds: [value.toolCallId], anchorId: 'answer', messages: 1, toolCalls: 1, thought: false, anchorThought: false } } : {},
  };
  return renderToStaticMarkup(h(ConfigProvider, { motion }, h(TranscriptView, { transcript, mode })));
};

const skill = run();
const mcp = run({ toolName: 'mcp__logs__log-service__search_logs', args: { query: 'PRIVATE-QUERY' } });
for (const [value, label, identity] of [
  [skill, '正在加载 Skill', 'log-analysis'],
  [mcp, '正在调用 MCP', 'log-service / search_logs'],
] as const) {
  for (const mode of ['compact', 'standard'] as const) {
    const html = renderTranscript(value, mode);
    const header = within(html, 'live-process-row');
    assert.ok(header.includes(label), `${mode} names the actual capability activity`);
    assert.ok(header.includes(identity), `${mode} keeps capability identity visible`);
    assert.ok(!header.includes('PRIVATE-QUERY'), 'collapsed header never substitutes raw arguments for identity');
  }
  for (const mode of ['detailed', 'verbose'] as const) {
    assert.ok(within(renderTranscript(value, mode), 'capability-tool-row').includes(identity));
  }
  const markup = renderRun(value);
  assert.ok(within(markup, 'capability-tool-card').includes('data-status="running"'));
  assert.ok(within(markup, 'capability-tool-row').includes('aria-expanded="false"'));
  assert.ok(!markup.includes('data-testid="capability-tool-details"'), 'loading content stays behind an explicit disclosure');
}

const success = run({ status: 'success', output: 'SKILL-CONTENT', details: { found: true, resource: 'SKILL.md' } });
assert.equal(capabilityCall(success)?.label, '已加载 Skill');
assert.ok(!renderRun(success).includes('SKILL-CONTENT'), 'successful skill content is collapsed');
const missing = run({ status: 'success', details: { found: false }, output: '技能不在配置范围内' });
assert.equal(capabilityCall(missing)?.status, 'error', 'missing skill is not a successful load');
const errorHtml = renderRun(missing);
assert.ok(within(errorHtml, 'capability-tool-row').includes('aria-expanded="true"'));
assert.ok(within(errorHtml, 'capability-tool-status').includes('加载失败'));
assert.ok(within(errorHtml, 'capability-tool-output').includes('技能不在配置范围内'));
const reference = run({ args: { name: 'log-analysis', resource: 'references/errors.md' } });
assert.equal(capabilityCall(reference)?.label, '正在读取 Skill 资源');
assert.equal(capabilityCall(reference)?.identity, 'log-analysis / references/errors.md');
for (const path of ['/skills/log-analysis/SKILL.md', 'C:\\skills\\log-analysis\\SKILL.md']) {
  assert.equal(capabilityCall(run({ toolName: 'read', args: { path } }))?.identity, 'log-analysis');
}
for (const value of [run({ toolName: 'read', args: { path: '/tmp/skills.ts' } }), run({ toolName: 'bash' }), run({ toolName: 'mcp_bogus' })]) {
  assert.equal(capabilityCall(value), null, 'ordinary tools keep their existing rendering');
}
assert.equal(capabilityCall(run({ ...mcp, toolName: 'mcp__server__search' }))?.identity, 'server / search');
assert.equal(capabilityCall(run({ ...mcp, details: { mcp: 'log-service', tool: 'search-logs' } }))?.identity, 'log-service / search-logs');
const failedMcp = run({ ...mcp, status: 'success', details: { isError: true }, output: '远端不可用' });
assert.equal(capabilityCall(failedMcp)?.label, 'MCP 调用失败');
assert.ok(within(renderRun(failedMcp), 'capability-tool-output').includes('远端不可用'));
assert.equal(capabilityCall(run({ ...mcp, status: 'success', output: 'MCP 调用失败：超时' }))?.status, 'error', 'old persisted failures retain their meaning');
assert.equal(capabilityCall(run({ ...mcp, status: 'success', output: 'ok' }))?.status, 'success');
assert.equal(capabilityCall(run({ ...mcp, status: 'success', output: 'MCP 调用失败：日志原文', details: { isError: false } }))?.status, 'success', 'structured status takes priority over quoted error text');

for (const value of [success, missing, failedMcp, run({ ...mcp, status: 'success' })]) {
  const header = within(renderTranscript(value, 'compact', true), 'turn-process-row');
  assert.ok(header.includes(capabilityCall(value)!.label));
  assert.ok(header.includes(capabilityCall(value)!.identity));
}
const mixed = completedProcessSpec([entry(success), entry({ ...failedMcp, toolCallId: 'mcp' })]);
assert.ok(mixed.label.includes('失败') && mixed.label.includes('已加载 Skill'), 'mixed success/failure remains explicit');
assert.ok(mixed.identity?.includes('log-analysis') && mixed.identity.includes('log-service'));
assert.equal(liveProcessSpec([entry(success)], null).label, '正在分析请求', 'finished load is never shown as still loading');

// Both event delivery and stored messages must preserve the bridge's error metadata.
const result = { content: [{ type: 'text', text: '远端不可用' }], details: { mcp: 'log-service', tool: 'search_logs', isError: true } };
let streamed = applyPiEvent(createTranscript(), { type: 'tool_execution_start', toolCallId: 'mcp', toolName: mcp.toolName, args: mcp.args } as PiEvent);
streamed = applyPiEvent(streamed, { type: 'tool_execution_end', toolCallId: 'mcp', toolName: mcp.toolName, result, isError: false } as PiEvent);
const replayed = applySnapshot(createTranscript(), [{ role: 'toolResult', toolCallId: 'mcp', toolName: mcp.toolName, ...result, isError: false, timestamp: 1 } as PiAgentMessage]);
for (const state of [streamed, replayed]) {
  const value = state.entries.find(item => item.kind === 'toolResult') as ToolResultEntry;
  assert.ok(value, 'a tool result is retained');
  assert.equal(capabilityCall(value.run)?.status, 'error');
}

console.log('capability tools: Skill/MCP identity, disclosure, failures, modes and replay passed');
