import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { WorkbenchInputError, type WorkbenchStore } from '../../workbench/store';
import { ensureRequirementLifecycle } from './lifecycle-events';
import { readRequirementTrace } from './lifecycle-trace';
import { submitRequirementDelivery, reviewRequirementDelivery } from './lifecycle-deliveries';

const COOKIE = 'pi_webx_requirement_reviewer';
function actor(request: Request, response: Response, store: WorkbenchStore): string {
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS requirement_lifecycle_user_keys (key TEXT PRIMARY KEY)`);
  const value = request.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (value && /^[a-f0-9]{48}$/.test(value)
    && store.sqlite.prepare('SELECT 1 FROM requirement_lifecycle_user_keys WHERE key=?').get(value)) return `user:${value}`;
  const key = randomBytes(24).toString('hex');
  store.sqlite.prepare('INSERT INTO requirement_lifecycle_user_keys(key) VALUES (?)').run(key);
  response.setHeader('Set-Cookie', `${COOKIE}=${key}; Path=/api/workbench/requirements; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return `user:${key}`;
}
function param(request: Request, key: string): string {
  const value = request.params[key]; return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
function fail(error: unknown, response: Response): void {
  response.status(error instanceof WorkbenchInputError ? error.status : 500)
    .json({ error: error instanceof WorkbenchInputError ? error.message : '需求追踪暂时不可用' });
}

export function createRequirementLifecycleRouter(store: WorkbenchStore): Router {
  const router = Router();
  ensureRequirementLifecycle(store);
  router.get('/requirements/:id/trace', (request, response) => {
    try {
      actor(request, response, store);
      if (Object.keys(request.query).some(key => key !== 'lookup')) throw new WorkbenchInputError('追踪查询包含未知参数');
      const lookup = request.query.lookup ?? 'auto';
      if (lookup !== 'id' && lookup !== 'human' && lookup !== 'auto') throw new WorkbenchInputError('追踪查询模式不合法');
      response.json(readRequirementTrace(store, param(request, 'id'), lookup));
    } catch (error) { fail(error, response); }
  });
  router.post('/requirements/:id/deliveries', (request, response) => {
    try { response.status(201).json(submitRequirementDelivery(store, param(request, 'id'), request.body,
      actor(request, response, store))); }
    catch (error) { fail(error, response); }
  });
  router.post('/requirements/:id/deliveries/:deliveryId/review', (request, response) => {
    try { response.json(reviewRequirementDelivery(store, param(request, 'id'), param(request, 'deliveryId'),
      request.body, actor(request, response, store))); }
    catch (error) { fail(error, response); }
  });
  return router;
}
