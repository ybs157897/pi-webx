import { BookOpen, ChevronDown, ChevronRight, Plug } from 'lucide-react';
import { useId, useState } from 'react';

import { formatArgs } from '../lib/format';
import type { CapabilityCall } from '../lib/capability-call';
import type { ToolRun } from '../shared/transcript';
import { StateDot } from '../ui/primitives';
import { MessageImages } from './MessageImages';
import css from './CapabilityToolCard.module.css';

export function CapabilityToolCard({ run, call }: { run: ToolRun; call: CapabilityCall }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const id = useId();
  const open = manual ?? call.status === 'error';
  const Glyph = call.kind === 'skill' ? BookOpen : Plug;
  return (
    <div className={css.card} data-testid="capability-tool-card" data-kind={call.kind} data-status={call.status}>
      <button
        className={css.row}
        type="button"
        data-testid="capability-tool-row"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${call.label}：${call.identity}`}
        title={`${call.label}：${call.identity}`}
        onClick={() => setManual(!open)}
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <Glyph size={14} aria-hidden />
        <span className={css.kind}>{call.kind === 'skill' ? 'Skill' : 'MCP'}</span>
        <span className={css.identity} data-testid="capability-tool-identity">{call.identity}</span>
        <span className={css.status}>
          {call.status !== 'success' && <StateDot state={call.status === 'error' ? 'error' : 'ongoing'} />}
          <span data-testid="capability-tool-status">{call.statusText}</span>
        </span>
      </button>
      {open && (
        <div id={id} className={css.body} data-testid="capability-tool-details" aria-busy={call.status === 'running'}>
          {Object.keys(run.args).length > 0 && (
            <div>
              <div className={css.caption}>参数</div>
              <pre className={css.payload} tabIndex={0} aria-label="调用参数">{formatArgs(run.args)}</pre>
            </div>
          )}
          <div>
            <div className={css.caption}>{call.outputLabel}</div>
            <pre className={css.payload} data-testid="capability-tool-output" tabIndex={0} aria-label={call.outputLabel}>
              {run.output || (call.status === 'running'
                ? call.kind === 'skill' ? '正在读取技能内容…' : '等待服务返回…'
                : call.status === 'error' ? '未返回错误详情' : '未返回文本内容')}
            </pre>
          </div>
          {run.images !== undefined && run.images.length > 0 && <MessageImages images={run.images} label={`${call.identity} 返回`} />}
        </div>
      )}
    </div>
  );
}
