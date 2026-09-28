import type { ToolRun, ToolRunStatus } from '../shared/transcript';

export interface CapabilityCall {
  kind: 'skill' | 'mcp';
  identity: string;
  label: string;
  status: ToolRunStatus;
  statusText: string;
  outputLabel: string;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Only actual tool calls are evidence of loading; configured capabilities are not. */
export function capabilityCall(run: ToolRun): CapabilityCall | null {
  const details = run.details && typeof run.details === 'object'
    ? run.details as Record<string, unknown> : {};
  const path = string(run.args.path ?? run.args.file_path ?? run.args.filePath).replace(/\\/g, '/');
  const skillFile = run.toolName === 'read' && /(?:^|\/)SKILL\.md$/.test(path);
  if (run.toolName === 'skills_read' || skillFile) {
    const name = skillFile
      ? path.split('/').at(-2) || 'SKILL.md'
      : string(run.args.name) || string(details.name) || '未命名技能';
    const resource = skillFile ? '' : string(run.args.resource) || string(details.resource);
    const reference = resource !== '' && resource !== 'SKILL.md';
    const status = run.status === 'running' ? 'running'
      : run.status === 'error' || details.found === false ? 'error' : 'success';
    const labels = reference
      ? { running: '正在读取 Skill 资源', success: '已读取 Skill 资源', error: 'Skill 资源读取失败' }
      : { running: '正在加载 Skill', success: '已加载 Skill', error: 'Skill 加载失败' };
    return {
      kind: 'skill', identity: reference ? `${name} / ${resource}` : name,
      status, label: labels[status],
      statusText: status === 'running' ? (reference ? '读取中' : '加载中')
        : status === 'error' ? (reference ? '读取失败' : '加载失败') : (reference ? '已读取' : '已加载'),
      outputLabel: status === 'error' ? '错误信息' : reference ? '参考内容' : '技能正文',
    };
  }

  // Module bridge: mcp__agent__connection__tool; external tools: mcp__server__tool.
  const parts = run.toolName.split('__');
  if (parts[0] !== 'mcp' || parts.length < 3 || parts.some(part => !part)) return null;
  const moduleTool = parts.length >= 4;
  const service = string(details.mcp) || parts[moduleTool ? 2 : 1]!;
  const tool = string(details.tool) || parts.slice(moduleTool ? 3 : 2).join('__');
  // Older persisted results contain only the adapter's error prefix.
  const error = typeof details.isError === 'boolean'
    ? details.isError : /^MCP (?:工具报错|调用失败)：/.test(run.output);
  const status = run.status === 'running' ? 'running'
    : run.status === 'error' || error ? 'error' : 'success';
  return {
    kind: 'mcp', identity: `${service} / ${tool}`, status,
    label: { running: '正在调用 MCP', success: 'MCP 已返回', error: 'MCP 调用失败' }[status],
    statusText: { running: '调用中', success: '已返回', error: '调用失败' }[status],
    outputLabel: status === 'error' ? '错误信息' : '返回结果',
  };
}
