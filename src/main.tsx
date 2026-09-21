import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

const App = lazy(() => import('./App'));
const Workbench = lazy(() => import('./workbench/Workbench'));
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
const showAgent =
  window.location.pathname === '/chat' ||
  new URLSearchParams(window.location.search).has('session');

createRoot(container).render(
  <StrictMode>
    <ConfigProvider motion={motion}>
      <Suspense
        fallback={
          <div style={{ padding: 32, color: '#37634d' }}>正在打开工作台…</div>
        }
      >
        {showAgent ? <App /> : <Workbench />}
      </Suspense>
    </ConfigProvider>
  </StrictMode>,
);
