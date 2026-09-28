import express, { type Request, type Response } from 'express';
import { CodesIdeRuntime } from './ide-runtime';
import { proxyGatewayHttp, sameOrigin } from './ide-proxy';

export function createCodesIdeRouter(runtime: CodesIdeRuntime, getDefaultRoot: () => Promise<string>): express.Router {
  const router = express.Router();

  router.get('/ide/config', async (_req: Request, res: Response) => {
    try {
      const defaultRoot = await getDefaultRoot();
      res.json({ gatewayUrl: '/api/codes/gateway', token: '', embedded: true, defaultRoot });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.get('/ide/status', async (_req: Request, res: Response) => {
    res.json(await runtime.status());
  });
  router.post('/ide/start', async (req: Request, res: Response) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: '跨站请求已拒绝' });
      return;
    }
    try {
      await runtime.start();
      res.json({ ready: true });
    } catch (error) {
      res.status(503).json({ ready: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.use('/gateway', (req: Request, res: Response) => {
    void proxyGatewayHttp(req, res, runtime);
  });
  router.use('/ide', express.static(runtime.distDir, { index: 'index.html', fallthrough: false }));
  return router;
}
