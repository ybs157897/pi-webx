import { Router } from 'express';
import type { Request } from 'express';
import { WorkbenchInputError, WorkbenchStore } from './store';
import { importRequirementTasks } from '../modules/requirements/import-tasks';
import { applyLifePlan, discardLifePlan } from '../modules/life/service';

function param(request: Request, key: string): string {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function assertNoSessionClaim(module: string, fields: unknown): void {
  if (module === 'requirements' && fields !== null && typeof fields === 'object' && Object.hasOwn(fields, 'sourceSessionId')) {
    throw new WorkbenchInputError('来源会话只能由需求 Agent 记录');
  }
  if (module === 'tasks' && fields !== null && typeof fields === 'object'
    && ['captureSessionId', 'captureEntryKey', 'captureFingerprint'].some(key => Object.hasOwn(fields, key))) {
    throw new WorkbenchInputError('待办收集来源只能由生活秘书记录');
  }
}

export function createWorkbenchRouter(store: WorkbenchStore): Router {
  const router = Router();

  router.get('/health', (_request, response) => {
    response.json({ ok: true, storage: 'sqlite' });
  });

  router.get('/state', (_request, response) => {
    const { chatLog: _chatLog, ...data } = store.read();
    response.json({ profile: data.profile, data, prefs: store.readPrefs(), empty: store.isEmpty() });
  });

  router.get('/export', (_request, response) => {
    response.json(store.read());
  });

  // 具体路由必须排在 /:module 通配之前，否则会被当成模块名匹配掉。
  router.get('/search', (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.slice(0, 100) : '';
    response.json({ results: store.search(query) });
  });

  // 双向链接查询（出链 / 反链）：同样是具体路由，排在 /:module 通配之前。
  router.get('/links/:module/:id', (request, response) => {
    response.json(store.links(param(request, 'module'), param(request, 'id')));
  });

  router.get('/prefs', (_request, response) => {
    response.json({ prefs: store.readPrefs() });
  });

  router.put('/prefs', (request, response) => {
    response.json({ prefs: store.writePrefs(request.body) });
  });

  router.post('/demo-data', (_request, response) => {
    store.loadDemo();
    response.json({ ok: true });
  });

  router.delete('/demo-data', (_request, response) => {
    store.resetAll();
    response.json({ ok: true });
  });

  router.post('/import', (request, response) => {
    store.import(request.body);
    response.json({ ok: true });
  });

  router.post('/requirements/:id/import-tasks', (request, response) => {
    response.json(importRequirementTasks(store, param(request, 'id'), request.body));
  });

  router.post('/life/plans/:id/apply', (request, response) => {
    response.json(applyLifePlan(store, param(request, 'id'), request.body));
  });

  router.delete('/life/plans/:id', (request, response) => {
    response.json(discardLifePlan(store, param(request, 'id')));
  });

  router.post('/:module', (request, response) => {
    const module = param(request, 'module');
    if (module === 'lifePlans') throw new WorkbenchInputError('生活安排建议只能由生活秘书生成');
    assertNoSessionClaim(module, request.body);
    response.json({ record: store.addRecord(module, request.body) });
  });

  router.patch('/:module/:id', (request, response) => {
    const module = param(request, 'module');
    if (module === 'lifePlans') throw new WorkbenchInputError('生活安排建议只能通过确认接口应用');
    assertNoSessionClaim(module, request.body);
    response.json({ record: store.updateRecord(module, param(request, 'id'), request.body) });
  });

  router.delete('/:module/:id', (request, response) => {
    const module = param(request, 'module');
    if (module === 'lifePlans') throw new WorkbenchInputError('生活安排建议只能通过取消接口删除');
    store.removeRecord(module, param(request, 'id'));
    response.json({ ok: true });
  });

  return router;
}
