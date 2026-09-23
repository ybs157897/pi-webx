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
    response.json({ profile: data.profile, data });
  });

  router.get('/export', (_request, response) => {
    response.json(store.read());
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
