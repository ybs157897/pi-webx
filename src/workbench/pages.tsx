import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  Ellipsis,
  Filter,
  Flag,
  List,
  ListFilter,
  Maximize2,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  X,
} from 'lucide-react';
import { issues, laterTodos, logRows, todos } from './data';
import { MockButton, PageHeading, PriorityMark, Status } from './components';

export function IssuesPage() {
  return (
    <>
      <PageHeading
        eyebrow="A LITTLE BETTER, EVERY DAY"
        title="问题修复"
        description="让每一个待解决的问题，都有一个清晰的落点。"
        action={
          <MockButton primary>
            <Plus size={16} />
            新建问题
          </MockButton>
        }
      />
      <section className="wd-issue-summary" aria-label="问题概况">
        <div>
          <span>我的问题</span>
          <strong>
            08<small>全部 Bug 单</small>
          </strong>
        </div>
        <div>
          <span>
            <i className="wd-dot wd-dot-gray" />
            待处理
          </span>
          <strong>
            02<small>等待开始</small>
          </strong>
        </div>
        <div>
          <span>
            <i className="wd-dot wd-dot-amber" />
            处理中
          </span>
          <strong>
            02<small>正在推进</small>
          </strong>
        </div>
        <div>
          <span>
            <i className="wd-dot wd-dot-green" />
            已解决
          </span>
          <strong>
            03<small>还有 1 个待验证</small>
          </strong>
        </div>
      </section>
      <div className="wd-issue-layout">
        <section className="wd-panel wd-issue-list">
          <div className="wd-list-top">
            <div className="wd-tabs">
              <span className="is-active">
                全部问题 <b>8</b>
              </span>
              <span>进行中</span>
              <span>已完成</span>
            </div>
            <div className="wd-view-icon">
              <List size={17} />
              <span />
              <SlidersHorizontal size={16} />
            </div>
          </div>
          <div className="wd-filter-row">
            <label className="wd-search-input">
              <Search size={15} />
              <input
                placeholder="搜索问题标题、编号..."
                aria-label="搜索问题（静态展示）"
                readOnly
              />
            </label>
            <MockButton>
              <Filter size={14} />
              筛选
            </MockButton>
            <MockButton>
              <ArrowDown size={14} />
              最近更新
            </MockButton>
          </div>
          <div className="wd-issue-table-wrap">
            <div className="wd-issue-table-head">
              <span>问题</span>
              <span>状态</span>
              <span>更新于</span>
            </div>
            {issues.map((issue, index) => (
              <article
                key={issue.id}
                className={`wd-issue-row ${index === 0 ? 'is-selected' : ''}`}
              >
                <PriorityMark priority={issue.priority} />
                <div className="wd-issue-name">
                  <h3>{issue.title}</h3>
                  <div className="wd-row-meta">
                    <span className="wd-mono">{issue.id}</span>
                    <span className="wd-meta-dot" />
                    <span>{issue.app}</span>
                    <span className="wd-small-tag">{issue.tag}</span>
                  </div>
                </div>
                <Status status={issue.status} />
                <time>{issue.updated}</time>
              </article>
            ))}
          </div>
          <footer className="wd-list-footer">
            <span>共 8 个问题</span>
            <div>
              <ChevronLeft size={15} />
              <span className="wd-page-number">1</span>
              <ChevronRight size={15} />
            </div>
          </footer>
        </section>
        <aside className="wd-panel wd-issue-detail">
          <header className="wd-detail-header">
            <span>
              <span className="wd-mono">BUG-0248</span>
              <ArrowUpRight size={14} />
            </span>
            <span>
              <Ellipsis size={18} />
              <Maximize2 size={13} />
            </span>
          </header>
          <div className="wd-detail-content">
            <div className="wd-detail-kicker">问题详情</div>
            <h2>
              订单详情页偶发
              <br />
              加载失败
            </h2>
            <div className="wd-detail-status">
              <Status status="处理中" />
              <span className="wd-small-tag">前端</span>
            </div>
            <dl className="wd-properties">
              <div>
                <dt>优先级</dt>
                <dd>
                  <PriorityMark priority="high" label />
                </dd>
              </div>
              <div>
                <dt>所属应用</dt>
                <dd>商城管理后台</dd>
              </div>
              <div>
                <dt>处理人</dt>
                <dd>
                  <span className="wd-mini-avatar">Y</span>我
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>09 月 21 日 09:30</dd>
              </div>
            </dl>
            <section className="wd-description">
              <h3>问题描述</h3>
              <p>
                进入订单详情时，页面偶尔停留在加载状态。刷新后恢复，频繁切换订单时更容易出现。
              </p>
              <div className="wd-expected">
                <span>预期表现</span>
                <p>切换订单后正常展示详情，异常时给出明确反馈。</p>
              </div>
            </section>
            <section className="wd-detail-activity">
              <h3>
                处理记录 <span>2</span>
              </h3>
              <div>
                <span className="wd-timeline-dot" />
                <p>
                  开始排查请求超时原因<small>今天 10:30</small>
                </p>
              </div>
              <div>
                <span className="wd-timeline-dot wd-timeline-light" />
                <p>
                  创建了这个问题<small>今天 09:30</small>
                </p>
              </div>
            </section>
          </div>
          <footer className="wd-detail-footer">
            <MockButton primary>
              <Code2 size={15} />
              继续修复
              <ArrowRight size={15} />
            </MockButton>
            <MockButton>
              <Ellipsis size={17} />
            </MockButton>
          </footer>
        </aside>
      </div>
      <div className="wd-footnote">
        <span className="wd-dot wd-dot-green" />
        静态 Bug 单示例<span>先让问题有序，再从容解决。</span>
      </div>
    </>
  );
}

export function LogsPage() {
  const bars = [
    20, 28, 18, 32, 24, 19, 30, 24, 36, 26, 20, 32, 40, 28, 22, 36, 26, 34, 46,
    28, 32, 40, 30, 22, 36, 48, 32, 26, 38, 30, 44, 28, 50, 42, 36, 54, 40, 32,
    48, 66, 52, 40, 60, 44, 56, 70, 52, 42,
  ];
  return (
    <>
      <PageHeading
        eyebrow="LESS NOISE. MORE SIGNAL."
        title="线上日志"
        description="在纷繁的运行记录里，找到值得留意的信号。"
        action={
          <div className="wd-production">
            <span className="wd-dot wd-dot-green" />
            生产环境<span>示例</span>
          </div>
        }
      />
      <section className="wd-query-panel">
        <div className="wd-query-filters">
          <div>
            <span>日志来源</span>
            <strong>
              <span className="wd-dot wd-dot-green" />
              生产集群 / 华东
              <ChevronDown size={13} />
            </strong>
          </div>
          <div>
            <span>应用服务</span>
            <strong>
              全部服务
              <ChevronDown size={13} />
            </strong>
          </div>
          <div>
            <span>时间范围</span>
            <strong>
              <Clock3 size={14} />
              最近 1 小时
              <ChevronDown size={13} />
            </strong>
          </div>
          <MockButton>
            <SlidersHorizontal size={15} />
            更多条件
          </MockButton>
        </div>
        <div className="wd-query-line">
          <label>
            <Search size={17} />
            <input
              aria-label="日志关键词（静态展示）"
              readOnly
              placeholder="输入关键词、Trace ID 或查询语句..."
            />
          </label>
          <span className="wd-query-shortcut">↵</span>
          <MockButton primary>
            查询日志
            <ArrowRight size={15} />
          </MockButton>
        </div>
        <div className="wd-query-hints">
          <span>常用查询</span>
          <code>level:ERROR</code>
          <code>service:order-service</code>
          <code>"timeout"</code>
        </div>
      </section>
      <section className="wd-panel wd-chart-panel">
        <header>
          <h2>
            日志分布 <span>09:42 — 10:42</span>
          </h2>
          <div className="wd-chart-legend">
            <span>
              <i className="wd-bar-info" />
              正常
            </span>
            <span>
              <i className="wd-bar-warn" />
              警告
            </span>
            <span>
              <i className="wd-bar-error" />
              错误
            </span>
          </div>
        </header>
        <div
          className="wd-chart"
          role="img"
          aria-label="示意图：一小时内日志量逐渐增多，后半段出现较多错误"
        >
          <div className="wd-chart-grid">
            <span>100</span>
            <span>50</span>
            <span>0</span>
          </div>
          <div className="wd-chart-bars">
            {bars.map((height, i) => (
              <div key={i} style={{ height }}>
                <i className="wd-bar-info" style={{ flex: 7 }} />
                <i
                  className="wd-bar-warn"
                  style={{ flex: i % 3 === 0 ? 2 : 0 }}
                />
                <i
                  className="wd-bar-error"
                  style={{ flex: i > 31 && i % 2 === 0 ? 3 : 0 }}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="wd-chart-times">
          <span>09:42</span>
          <span>09:57</span>
          <span>10:12</span>
          <span>10:27</span>
          <span>10:42</span>
        </div>
      </section>
      <section className="wd-log-console">
        <header>
          <div className="wd-console-tabs">
            <span className="is-active">
              全部日志 <b>12</b>
            </span>
            <span>
              ERROR <b>2</b>
            </span>
            <span>
              WARN <b>2</b>
            </span>
            <span>
              INFO <b>8</b>
            </span>
          </div>
          <div>
            <span className="wd-console-mode">快照视图</span>
            <ArrowDownToLine size={15} />
            <Ellipsis size={18} />
          </div>
        </header>
        <div className="wd-console-body">
          <div className="wd-console-lines">
            <div className="wd-console-table-head">
              <span>
                时间 <ArrowDown size={11} />
              </span>
              <span>级别</span>
              <span>日志内容</span>
            </div>
            {logRows.map((log, i) => (
              <div
                key={log.time}
                className={`wd-log-row ${i === 0 ? 'is-selected' : ''}`}
              >
                <time>{log.time}</time>
                <span className={`wd-log-level wd-level-${log.level}`}>
                  {log.level}
                </span>
                <div>
                  <span>{log.message}</span>
                  <small>{log.service}</small>
                </div>
              </div>
            ))}
          </div>
          <aside className="wd-log-detail">
            <header>
              <h3>日志详情</h3>
              <X size={16} />
            </header>
            <span className="wd-log-level wd-level-ERROR">ERROR</span>
            <p>
              Failed to fetch order detail:
              <br />
              upstream request timeout
            </p>
            <dl>
              <div>
                <dt>时间</dt>
                <dd>2026-09-21 10:42:38.291</dd>
              </div>
              <div>
                <dt>服务</dt>
                <dd>order-service</dd>
              </div>
              <div>
                <dt>实例</dt>
                <dd>order-service-7d8b9-x2k4</dd>
              </div>
              <div>
                <dt>
                  Trace ID <Copy size={11} />
                </dt>
                <dd className="wd-trace">a8f21c09d4e7</dd>
              </div>
            </dl>
            <h4>原始内容</h4>
            <pre>
              {
                '{\n  "level": "ERROR",\n  "service": "order-service",\n  "duration": 3000,\n  "error": {\n    "code": "ETIMEDOUT",\n    "upstream": "mysql"\n  }\n}'
              }
            </pre>
          </aside>
        </div>
        <footer>
          <span>
            <span className="wd-dot wd-dot-green" />
            示例快照 · 12 条日志
          </span>
          <span>Asia/Shanghai · UTC+8</span>
        </footer>
      </section>
    </>
  );
}

function TodoItem({
  todo,
}: {
  todo: {
    title: string;
    category: string;
    due: string;
    done: boolean;
    note: string;
    important?: boolean;
  };
}) {
  return (
    <article className={`wd-todo-row ${todo.done ? 'is-done' : ''}`}>
      <span
        className="wd-checkbox"
        aria-label={todo.done ? '已完成' : '未完成'}
      >
        {todo.done && <Check size={12} />}
      </span>
      <div>
        <h3>
          {todo.title}
          {todo.important && <Flag size={12} />}
        </h3>
        {todo.note && <p>{todo.note}</p>}
      </div>
      <span
        className={`wd-category wd-category-${todo.category === '工作' ? 'work' : todo.category === '生活' ? 'life' : 'study'}`}
      >
        {todo.category}
      </span>
      <time>{todo.due}</time>
      <Ellipsis size={16} />
    </article>
  );
}

export function TodosPage() {
  return (
    <>
      <PageHeading
        eyebrow="YOUR SPACE. YOUR PACE."
        title="我的待办"
        description="给想做的事一个位置，也给今天留一点余地。"
        action={
          <MockButton primary>
            <Plus size={16} />
            记一件事
          </MockButton>
        }
      />
      <div className="wd-todo-layout">
        <div className="wd-todo-main">
          <section className="wd-week-strip">
            <div className="wd-month">
              <CalendarDays size={20} />
              <strong>
                九月<span>2026</span>
              </strong>
            </div>
            <div className="wd-week-days">
              {['一', '二', '三', '四', '五', '六', '日'].map((day, i) => (
                <div className={i === 0 ? 'is-today' : ''} key={day}>
                  <span>周{day}</span>
                  <strong>{21 + i}</strong>
                  <i />
                </div>
              ))}
            </div>
            <ChevronRight size={15} />
          </section>
          <section className="wd-panel wd-todo-panel">
            <div className="wd-list-top">
              <div className="wd-tabs">
                <span className="is-active">
                  全部待办 <b>8</b>
                </span>
                <span>工作</span>
                <span>生活</span>
                <span>学习</span>
              </div>
              <span className="wd-view-icon">
                <ListFilter size={17} />
                <span />
                <List size={17} />
              </span>
            </div>
            <div className="wd-todo-group-head">
              <h2>
                <span className="wd-dot wd-dot-green" />
                今天 <span>5</span>
              </h2>
              <small>2 / 5 已完成</small>
            </div>
            {todos.map((todo) => (
              <TodoItem key={todo.title} todo={todo} />
            ))}
            <div className="wd-inline-add">
              <Plus size={15} />
              <span>再记下一件事...</span>
              <kbd>↵</kbd>
            </div>
            <div className="wd-todo-group-head wd-later-head">
              <h2>
                <Circle size={10} />
                稍后 <span>3</span>
              </h2>
              <ChevronDown size={15} />
            </div>
            {laterTodos.map((todo) => (
              <TodoItem key={todo.title} todo={todo} />
            ))}
            <footer className="wd-todo-footer">
              <CheckCheck size={15} />
              <span>完成的小事，也值得被看见。</span>
              <span>已完成 2 件</span>
            </footer>
          </section>
        </div>
        <aside className="wd-todo-aside">
          <section className="wd-day-card">
            <div className="wd-eyebrow">TODAY, AT A GLANCE</div>
            <h2>不赶路，也在前进。</h2>
            <p>今天的 5 件小事，已经完成了 2 件。</p>
            <div
              className="wd-progress-ring"
              role="img"
              aria-label="今日完成百分之四十"
            >
              <div>
                <strong>
                  40<span>%</span>
                </strong>
                <small>今日进度</small>
              </div>
            </div>
            <div className="wd-progress-legend">
              <span>
                <i />
                已完成 2
              </span>
              <span>
                <i />
                待完成 3
              </span>
            </div>
          </section>
          <section className="wd-note-card">
            <header>
              <h2>
                <SquarePen size={16} />
                随手记
              </h2>
              <Ellipsis size={17} />
            </header>
            <div className="wd-note-paper">
              <p>
                一些还没成形的想法，
                <br />
                先放在这里。
              </p>
              <p>
                工作台不一定要装下所有事情，
                <br />
                顺手、安静，就很好。
              </p>
              <span className="wd-note-caret" />
            </div>
            <footer>
              <span>09.21</span>
              <span>留白，也是一种安排。</span>
            </footer>
          </section>
        </aside>
      </div>
      <div className="wd-footnote">
        <span className="wd-dot wd-dot-green" />
        静态个人待办示例<span>一件一件，慢慢来。</span>
      </div>
    </>
  );
}
