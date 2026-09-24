import { Router } from 'express';
import type { Request } from 'express';
import { WorkbenchStore } from './store';

function param(request: Request, key: string): string {
  const value = request.params[key];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
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

  router.put('/atoms/:module', (request, response) => {
    response.json({ profile: store.putAtomProfile(param(request, 'module'), request.body) });
  });

  router.post('/atoms/:module/records', (request, response) => {
    response.json({ record: store.addAtomRecord(param(request, 'module'), request.body) });
  });

  router.patch('/atoms/:module/records/:id', (request, response) => {
    response.json({ record: store.updateAtomRecord(param(request, 'module'), param(request, 'id'), request.body) });
  });

  router.delete('/atoms/:module/records/:id', (request, response) => {
    store.removeAtomRecord(param(request, 'module'), param(request, 'id'));
    response.json({ ok: true });
  });

  router.post('/:module', (request, response) => {
    response.json({ record: store.addRecord(param(request, 'module'), request.body) });
  });

  router.patch('/:module/:id', (request, response) => {
    response.json({ record: store.updateRecord(param(request, 'module'), param(request, 'id'), request.body) });
  });

  router.delete('/:module/:id', (request, response) => {
    store.removeRecord(param(request, 'module'), param(request, 'id'));
    response.json({ ok: true });
  });

  return router;
}
