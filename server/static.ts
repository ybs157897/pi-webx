import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';

/** Serve the built SPA and keep browser routes such as /chat reloadable. */
export function serveProductionAssets(app: express.Express, distDir: string): boolean {
  const indexHtml = path.join(distDir, 'index.html');
  if (!existsSync(indexHtml)) {
    console.warn(`[pi-webx] no build output at ${distDir} — run npm run build first. Falling back to /api only.`);
    return false;
  }

  const indexBody = readFileSync(indexHtml);
  app.use(express.static(distDir, { index: 'index.html' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();
    res.status(200).type('html').send(indexBody);
  });
  console.log(`[pi-webx] serving static assets + SPA fallback from ${distDir}`);
  return true;
}
