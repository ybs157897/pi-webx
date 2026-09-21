import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Bug,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Command,
  Layers2,
  LayoutGrid,
  Search,
  Terminal,
} from 'lucide-react';
import { viewLabels } from './data';
import type { View } from './data';
import { IssuesPage, LogsPage, TodosPage } from './pages';
import './workbench.css';

function currentView(): View {
  const value = window.location.hash.replace('#/', '');
  return value === 'logs' || value === 'todos' ? value : 'issues';
}

export default function Workbench() {
  const [view, setView] = useState<View>(currentView);
  useEffect(() => {
    const onHashChange = () => setView(currentView());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    document.title = `${viewLabels[view]} · pi desk`;
    document.querySelector('.wd-scroll')?.scrollTo(0, 0);
  }, [view]);
  const navItems = [
    { id: 'issues', icon: Bug, count: '05' },
    { id: 'logs', icon: Terminal, count: '' },
    { id: 'todos', icon: CheckCheck, count: '06' },
  ] as const;
  return (
    <div className="wd-root">
      <a
        className="wd-skip-link"
        href="#workbench-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('workbench-main')?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="wd-sidebar">
        <a className="wd-brand" href="#/issues" aria-label="pi desk 首页">
          <span className="wd-brand-mark">π</span>
          <span>
            pi <strong>desk</strong>
            <small>个人工作台</small>
          </span>
        </a>
        <div className="wd-space-picker">
          <span className="wd-space-icon">
            <LayoutGrid size={17} />
          </span>
          <span>
            Yin 的个人空间<small>一点秩序，一点从容</small>
          </span>
          <ChevronDown size={13} />
        </div>
        <div className="wd-nav-label">
          工作台<span>WORKSPACE</span>
        </div>
        <nav aria-label="工作台页面">
          {navItems.map(({ id, icon: Icon, count }) => (
            <a
              href={`#/${id}`}
              key={id}
              aria-current={view === id ? 'page' : undefined}
              className={`wd-nav-link ${view === id ? 'is-active' : ''}`}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{viewLabels[id]}</span>
              {count && <small>{count}</small>}
              {id === 'logs' && <i />}
            </a>
          ))}
        </nav>
        <div className="wd-sidebar-divider" />
        <div className="wd-sidebar-caption">
          <Layers2 size={15} />
          <span>三个工具，一个自己的空间。</span>
        </div>
        <div className="wd-sidebar-bottom">
          <div className="wd-sidebar-note">
            <span className="wd-note-leaf" />
            <p>
              事情慢慢做，
              <br />
              日子好好过。
            </p>
            <small>MAKE ROOM FOR WHAT MATTERS.</small>
          </div>
          <a className="wd-agent-link" href="/chat">
            <Command size={15} />
            Agent 对话
            <ArrowUpRight size={13} />
          </a>
          <div className="wd-profile">
            <span className="wd-avatar">Y</span>
            <span>
              Yin<small>个人空间</small>
            </span>
            <span className="wd-profile-dot" />
          </div>
        </div>
      </aside>
      <div className="wd-workspace">
        <header className="wd-topbar">
          <div className="wd-breadcrumb">
            <LayoutGrid size={14} />
            <span>个人空间</span>
            <ChevronRight size={13} />
            <strong>{viewLabels[view]}</strong>
          </div>
          <div className="wd-topbar-right">
            <label className="wd-global-search">
              <Search size={14} />
              <input
                readOnly
                aria-label="搜索工作台（静态展示）"
                placeholder="搜索工作台"
              />
              <kbd>⌘ K</kbd>
            </label>
            <span className="wd-prototype-label">
              <span />
              静态原型
            </span>
            <span className="wd-topbar-avatar">Y</span>
          </div>
        </header>
        <main className="wd-scroll" id="workbench-main" tabIndex={-1}>
          <div className="wd-page" key={view}>
            {view === 'issues' ? (
              <IssuesPage />
            ) : view === 'logs' ? (
              <LogsPage />
            ) : (
              <TodosPage />
            )}
            <footer className="wd-page-footer">
              <span>
                pi desk <i>/</i> 为自己的工作，留一个舒服的位置。
              </span>
              <span>DESIGN EXPLORATION · 01</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
