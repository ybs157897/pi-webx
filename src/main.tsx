import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
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

createRoot(container).render(
  <StrictMode>
    <ConfigProvider motion={motion}>
      <App />
    </ConfigProvider>
  </StrictMode>,
);
