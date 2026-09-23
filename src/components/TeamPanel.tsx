import { App as AntApp, Alert, Button, Drawer, Empty, Popconfirm, Spin, Tabs, Tag, theme } from 'antd';
import { RefreshCw, UsersRound } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';

import { api } from '../lib/api';
import type {
  TeamDeliveryState, TeamMemberStatus, TeamMessageView, TeamProjection, TeamTaskStatus,
} from '../shared/agent-team';
import css from './TeamPanel.module.css';

const MEMBER_LABEL: Record<TeamMemberStatus, string> = {
  running: '运行中', idle: '已完成', cancelling: '停止中',
  cancelled: '已取消', interrupted: '已中断', failed: '失败',
};
const TASK_LABEL: Record<TeamTaskStatus, string> = {
  pending: '待开始', in_progress: '进行中', blocked: '被依赖阻塞',
  completed: '已完成', failed: '失败', cancelled: '已取消',
};
const DELIVERY_LABEL: Record<TeamDeliveryState, string> = {
  queued: '待投递', inflight: '已认领', candidate: '待确认',
  'fresh-reader-visible': '已确认可见', failed: '投递失败',
};

const time = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

function statusColor(status: string): string {
  if (status === 'running' || status === 'in_progress') return 'processing';
  if (status === 'completed' || status === 'idle' || status === 'fresh-reader-visible') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'blocked' || status === 'interrupted' || status === 'candidate' || status === 'queued') return 'warning';
  return 'default';
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function payloadText(payload: unknown): string {
  let value: string;
  try {
    value = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    value = String(payload);
  }
  return value.length > 16000 ? `${value.slice(0, 16000)}\n…（面板仅展示前 16000 字）` : value;
}

function Members({ team }: { team: TeamProjection }) {
  if (team.members.length === 0) return <Empty description="还没有派发成员" />;
  return (
    <div className={css.stack}>
      {team.members.map((member) => (
        <article className={css.card} key={member.memberId}>
          <div className={css.cardHead}>
            <div className={css.cardTitle}>{member.definitionId}</div>
            <Tag color={statusColor(member.status)}>{MEMBER_LABEL[member.status]}</Tag>
          </div>
          <div className={css.meta}>定义修订 {member.definitionRevision} · {time.format(member.createdAt)} · 成员 {shortId(member.memberId)}</div>
          {member.statusReason && <div className={css.meta}>原因：{member.statusReason}</div>}
          {member.untrustedResult && (
            <details className={css.details}>
              <summary>查看成员结果{member.untrustedResult.truncated ? '（已截断）' : ''}</summary>
              <pre className={css.content}>{member.untrustedResult.text}</pre>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}

function Tasks({ team }: { team: TeamProjection }) {
  const memberNames = new Map(team.members.map((member) => [member.memberId, member.definitionId]));
  if (team.tasks.length === 0) return <Empty description="任务板还没有任务" />;
  return (
    <div className={css.stack}>
      {team.tasks.map((task) => (
        <article className={css.card} key={task.taskId}>
          <div className={css.cardHead}>
            <div className={css.cardTitle}>{task.untrusted.title}</div>
            <Tag color={statusColor(task.status)}>{TASK_LABEL[task.status]}</Tag>
          </div>
          {task.untrusted.description && <p className={css.description}>{task.untrusted.description}</p>}
          <div className={css.meta}>
            {task.ownerMemberId ? `负责人：${memberNames.get(task.ownerMemberId) ?? shortId(task.ownerMemberId)}` : '尚未分配'}
            {' · '}修订 {task.revision}
          </div>
          {task.blockedBy.length > 0 && <div className={css.meta}>依赖：{task.blockedBy.map(shortId).join('、')}</div>}
          {task.writeScopes.length > 0 && <div className={css.meta}>建议写入范围（非隔离）：{task.writeScopes.join('、')}</div>}
        </article>
      ))}
    </div>
  );
}

function Message({ item, memberNames }: { item: TeamMessageView; memberNames: Map<string, string> }) {
  const from = item.from === 'lead' ? '编排者' : memberNames.get(item.from) ?? shortId(item.from);
  const to = item.to === 'lead' ? '编排者' : memberNames.get(item.to) ?? shortId(item.to);
  return (
    <article className={css.card}>
      <div className={css.cardHead}>
        <div className={css.cardTitle}>#{item.seq} · {from} → {to}</div>
        <Tag color={statusColor(item.deliveryState)}>{DELIVERY_LABEL[item.deliveryState]}</Tag>
      </div>
      <div className={css.meta}>类型：{item.kind}{item.deliveryMode ? ` · ${item.deliveryMode}` : ''}</div>
      {item.pendingReason && <div className={css.meta}>待投原因：{item.pendingReason}</div>}
      {item.failureReason && <div className={css.failure}>投递原因：{item.failureReason}</div>}
      <pre className={css.content}>{payloadText(item.untrustedPayload)}</pre>
    </article>
  );
}

function Messages({ team }: { team: TeamProjection }) {
  const memberNames = new Map(team.members.map((member) => [member.memberId, member.definitionId]));
  if (team.messages.length === 0) return <Empty description="还没有团队消息" />;
  const latest = team.messages.slice(-100).reverse();
  return (
    <div className={css.stack}>
      {team.messages.length > 100 && <div className={css.meta}>显示最近 100 条，共 {team.messages.length} 条。</div>}
      {latest.map((item) => <Message key={item.messageId} item={item} memberNames={memberNames} />)}
    </div>
  );
}

export interface TeamPanelProps {
  open: boolean;
  onClose: () => void;
  sessionId: string | null;
  team: TeamProjection | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onNewTeam: () => void;
}

/** A read-only Team projection with the host's explicit cancel action. */
export function TeamPanel({
  open, onClose, sessionId, team, loading, error, onRefresh, onNewTeam,
}: TeamPanelProps) {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  const [stopping, setStopping] = useState(false);
  const running = useMemo(() => team?.members.filter((member) => (
    member.status === 'running' || member.status === 'cancelling'
  )).length ?? 0, [team]);
  const pending = team?.messages.filter((item) => (
    item.deliveryState === 'queued' || item.deliveryState === 'inflight' || item.deliveryState === 'candidate'
  )).length ?? 0;

  const stopTeam = async () => {
    if (sessionId === null || stopping) return;
    setStopping(true);
    try {
      const result = await api.cancelTeam(sessionId, '用户从 Team 面板请求停止。');
      message.info(`已请求停止 ${result.cancelled} 个成员；状态将在成员退出后更新。`);
      await onRefresh();
    } catch (cause) {
      message.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };

  return (
    <Drawer
      title={<span className={css.drawerTitle}><UsersRound size={18} aria-hidden="true" /> Agent Team</span>}
      open={open}
      onClose={onClose}
      width="min(720px, 100vw)"
      destroyOnHidden
      extra={
        <div className={css.actions}>
          <Button type="text" icon={<RefreshCw size={15} />} aria-label="刷新团队状态" onClick={() => void onRefresh()} />
          {team && running > 0 && (
            <Popconfirm title="停止正在运行的团队成员？" description="停止是协作式的，成员退出后状态才会更新。" onConfirm={() => void stopTeam()}>
              <Button danger loading={stopping} size="small">停止成员</Button>
            </Popconfirm>
          )}
        </div>
      }
    >
      <div className={css.panel} style={{
        '--team-border': token.colorBorderSecondary,
        '--team-muted': token.colorTextSecondary,
        '--team-surface': token.colorFillQuaternary,
      } as CSSProperties}>
        {error && <Alert type="error" showIcon message="团队状态读取失败" description={error} />}
        {loading && !team && <div className={css.center}><Spin description="读取团队状态" /></div>}
        {!loading && !team && (
          <div className={css.center}>
            <Empty description={sessionId ? '当前会话没有 Agent Team' : '先建立一个会话'} />
            <Button onClick={() => { onClose(); onNewTeam(); }}>新建 Agent Team</Button>
          </div>
        )}
        {team && (
          <>
            <div className={css.summary}>
              <div><strong>{team.members.length}</strong><span>成员 · {running} 运行中</span></div>
              <div><strong>{team.tasks.length}</strong><span>任务</span></div>
              <div><strong>{pending}</strong><span>待处理消息</span></div>
            </div>
            <Tabs
              defaultActiveKey="members"
              items={[
                { key: 'members', label: '成员', children: <Members team={team} /> },
                { key: 'tasks', label: '任务', children: <Tasks team={team} /> },
                { key: 'messages', label: '消息', children: <Messages team={team} /> },
              ]}
            />
            <p className={css.footnote}>中断的成员不会自动恢复。结果和任务文字由模型生成，请按原始内容核对。</p>
          </>
        )}
      </div>
    </Drawer>
  );
}
