import type { WorkbenchStore } from '../../workbench/store';
import type { ChatroomTaskStatus } from './contracts';
import { traceRunFinished } from './trace-links';
import type { ChatroomWorkStore, RunRow } from './work-store';

export function recoverInterruptedRuns(store: WorkbenchStore, storage: ChatroomWorkStore,
  setAssignmentStatus: (assignmentId: string, status: ChatroomTaskStatus) => void): void {
  storage.transaction(() => {
    const rows = storage.sqlite.prepare(`SELECT * FROM chatroom_work_runs
      WHERE workspace_key = ? AND status = 'running'`).all(storage.workspaceKey) as RunRow[];
    for (const run of rows) {
      const open = storage.sqlite.prepare(`SELECT 1 FROM chatroom_work_run_tools
        WHERE workspace_key = ? AND run_id = ? AND (finished_at IS NULL OR is_error = 1) LIMIT 1`)
        .get(storage.workspaceKey, run.id) !== undefined;
      const status = open ? 'needs_review' : 'interrupted';
      storage.sqlite.prepare(`UPDATE chatroom_work_runs SET status = ?, error = ?, finished_at = ?
        WHERE workspace_key = ? AND id = ?`)
        .run(status, open ? '工具副作用结果不明，须核对后恢复' : '服务重启中断执行，未自动重跑',
          new Date().toISOString(), storage.workspaceKey, run.id);
      if (run.assignment_id) setAssignmentStatus(run.assignment_id, status);
      traceRunFinished(store, storage.workspaceKey, storage.run(run.id)!);
    }
  });
}
