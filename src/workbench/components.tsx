import type { ReactNode } from 'react';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleEllipsis,
} from 'lucide-react';

export function Status({ status }: { status: string }) {
  const Icon =
    status === '已解决'
      ? CircleCheck
      : status === '处理中'
        ? CircleDot
        : status === '待验证'
          ? CircleEllipsis
          : CircleDashed;
  const tone =
    status === '已解决'
      ? 'resolved'
      : status === '处理中'
        ? 'progress'
        : status === '待验证'
          ? 'review'
          : 'open';
  return (
    <span className={`wd-status wd-status-${tone}`}>
      <Icon size={14} />
      {status}
    </span>
  );
}

export function PriorityMark({
  priority,
  label = false,
}: {
  priority: string;
  label?: boolean;
}) {
  const text =
    priority === 'high'
      ? '高优先级'
      : priority === 'medium'
        ? '中优先级'
        : '低优先级';
  return (
    <span className={`wd-priority wd-priority-${priority}`} title={text}>
      <span className="wd-priority-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {label ? text : <span className="wd-sr-only">{text}</span>}
    </span>
  );
}

export function MockButton({
  children,
  primary = false,
  className = '',
}: {
  children: ReactNode;
  primary?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`wd-btn ${primary ? 'wd-btn-primary' : ''} ${className}`}
      disabled
      title="静态原型，仅展示样式"
    >
      {children}
    </button>
  );
}

export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="wd-page-heading">
      <div>
        <div className="wd-eyebrow">{eyebrow}</div>
        <h1>
          {title}
          <span className="wd-heading-dot">.</span>
        </h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
