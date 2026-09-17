import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
// ThemeProvider's CDN font injection is disabled, so ship the math stylesheet locally.
import 'katex/dist/katex.min.css';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found in index.html');

createRoot(container).render(
  <StrictMode>
    <ConfigProvider motion={motion}>
      <App />
    </ConfigProvider>
  </StrictMode>,
);
