import { Router } from 'express';
import type { Request, Response } from 'express';
import { isSettingsId, ModuleAgentSettingsService } from './service';
import { SettingsError } from './validation';

export function createModuleAgentSettingsRouter(service: ModuleAgentSettingsService): Router {
  const router = Router();
  const respond = (res: Response, error: unknown) => {
    const status = error instanceof SettingsError ? error.status : 400;
    const message = error instanceof SettingsError ? error.message : '模块 Agent 配置不可用';
    res.status(status).json({ error: message });
  };
  router.get('/:agentId/settings', async (req: Request, res: Response) => {
    const id = req.params.agentId;
    if (typeof id !== 'string' || !isSettingsId(id)) { res.status(404).json({ error: '未知模块 Agent' }); return; }
    try { res.json(await service.get(id)); } catch (error) { respond(res, error); }
  });
  router.put('/:agentId/settings', async (req: Request, res: Response) => {
    const id = req.params.agentId;
    if (typeof id !== 'string' || !isSettingsId(id)) { res.status(404).json({ error: '未知模块 Agent' }); return; }
    try { res.json(await service.update(id, req.body)); } catch (error) { respond(res, error); }
  });
  return router;
}
