import { createHash } from 'node:crypto';
import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import { WorkbenchInputError } from '../../workbench/store';

export function bad(message: string, status = 400): never { throw new WorkbenchInputError(message, status); }
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function validAgent(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);
}
export function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) bad(`${label}须为 1 到 ${max} 字`);
  return value.trim();
}
export function assertFields(input: unknown, action: string, fields: readonly string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || (input as { action?: unknown }).action !== action
    || Object.keys(input).some(key => !fields.includes(key))) bad('工作工具参数不合法');
}
