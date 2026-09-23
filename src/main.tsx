import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

const AgentApp = lazy(() => import('./App'));
const WorkbenchRoot = lazy(() => import('./workbench-app/WorkbenchRoot.jsx'));
// ThemeProvider's CDN font injection is disabled, so ship the math stylesheet locally.
import 'katex/dist/katex.min.css';
import '@jboltai/tokui/css';
import './index.css';
// The dsw design platform (after index.css so its token-driven scrollbar skin
// wins over the page-wide rules there).
import './ui/theme/design-platform.css';
import './ui/theme/elevation.css';
import './ui/theme/base.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found in index.html');

const showAgent = (window.location.pathname === '/chat' || window.location.pathname.startsWith('/chat/'))
  || new URLSearchParams(window.location.search).has('session');
if (!showAgent) document.title = 'AI 个人工作台';

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<div style={{ padding: 32 }}>正在打开工作台…</div>}>
      {showAgent
        ? <ConfigProvider motion={motion}><AgentApp /></ConfigProvider>
        : <WorkbenchRoot />}
    </Suspense>
  </StrictMode>,
);
