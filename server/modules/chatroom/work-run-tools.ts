import type { WorkbenchStore } from '../../workbench/store';
import { bad, requiredText } from './work-input';
import type { ChatroomWorkStore } from './work-store';
import { traceTool } from './trace-links';

export function markToolStart(store: WorkbenchStore, storage: ChatroomWorkStore,
  runId: string, toolCallId: string, toolName: string): void {
  requiredText(toolCallId, '工具调用 ID', 500);
  requiredText(toolName, '工具名称', 200);
  storage.transaction(() => {
    const run = storage.run(runId);
    if (!run || run.status !== 'running') bad('执行记录未处于运行状态', 409);
    const existing = storage.sqlite.prepare(`SELECT tool_name FROM chatroom_work_run_tools
      WHERE workspace_key = ? AND run_id = ? AND tool_call_id = ?`)
      .get(storage.workspaceKey, runId, toolCallId) as { tool_name: string } | undefined;
    if (existing && existing.tool_name !== toolName) bad('工具调用 ID 已用于其他工具', 409);
    if (!existing) storage.sqlite.prepare(`INSERT INTO chatroom_work_run_tools
      (workspace_key, run_id, tool_call_id, tool_name, started_at) VALUES (?, ?, ?, ?, ?)`)
      .run(storage.workspaceKey, runId, toolCallId, toolName, new Date().toISOString());
    const tool = storage.sqlite.prepare(`SELECT * FROM chatroom_work_run_tools
      WHERE workspace_key = ? AND run_id = ? AND tool_call_id = ?`)
      .get(storage.workspaceKey, runId, toolCallId) as Parameters<typeof traceTool>[3];
    traceTool(store, storage.workspaceKey, run, tool);
  });
}

export function markToolEnd(store: WorkbenchStore, storage: ChatroomWorkStore,
  runId: string, toolCallId: string, isError: boolean,
  facts?: { resultHash: string; resultBytes: number; exitCode: number | null }): void {
  if (facts && (!/^[a-f0-9]{64}$/.test(facts.resultHash)
    || !Number.isSafeInteger(facts.resultBytes) || facts.resultBytes < 0
    || (facts.exitCode !== null && (!Number.isSafeInteger(facts.exitCode) || facts.exitCode < 0)))) {
    bad('工具结果摘要不合法');
  }
  storage.transaction(() => {
    const result = storage.sqlite.prepare(`UPDATE chatroom_work_run_tools
      SET finished_at = COALESCE(finished_at, ?), is_error = COALESCE(is_error, ?),
        result_hash = COALESCE(result_hash, ?), result_bytes = COALESCE(result_bytes, ?),
        exit_code = COALESCE(exit_code, ?)
      WHERE workspace_key = ? AND run_id = ? AND tool_call_id = ?`)
      .run(new Date().toISOString(), isError ? 1 : 0,
        facts?.resultHash ?? null, facts?.resultBytes ?? null, facts?.exitCode ?? null,
        storage.workspaceKey, runId, toolCallId);
    if (!result.changes) bad('工具调用开始记录不存在', 409);
    const run = storage.run(runId)!;
    const tool = storage.sqlite.prepare(`SELECT * FROM chatroom_work_run_tools
      WHERE workspace_key = ? AND run_id = ? AND tool_call_id = ?`)
      .get(storage.workspaceKey, runId, toolCallId) as Parameters<typeof traceTool>[3];
    traceTool(store, storage.workspaceKey, run, tool);
  });
}
