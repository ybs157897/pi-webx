import { Router } from 'express';
import type { Request, Response } from 'express';
import { WorkbenchInputError } from '../../workbench/store';
import type { ChatroomService } from './service';
import type { ChatroomUserSendInput } from './contracts';
import type { WorkTaskActionInput } from './work-contracts';
import { publicMessage } from './store';

const USER_COOKIE = 'pi_webx_chatroom_user';

function userSession(request: Request, response: Response, service: ChatroomService): string {
  const cookie = request.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${USER_COOKIE}=`))?.slice(USER_COOKIE.length + 1);
  const existing = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : undefined;
  const key = service.ensureUserSession(existing);
  if (key !== existing) {
    response.setHeader('Set-Cookie', `${USER_COOKIE}=${key}; Path=/api/chatroom; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  return key;
}

function integer(raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new WorkbenchInputError('分页参数不合法');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new WorkbenchInputError('分页参数不合法');
  return value;
}

function watch(raw: unknown): number[] {
  if (raw === undefined || raw === '') return [];
  if (typeof raw !== 'string' || !/^\d+(,\d+)*$/.test(raw)) throw new WorkbenchInputError('状态观察参数不合法');
  const values = raw.split(',').map(Number);
  if (values.length > 100 || values.some(value => !Number.isSafeInteger(value) || value < 1)) {
    throw new WorkbenchInputError('状态观察参数不合法');
  }
  return values;
}

/** Mount at /api/chatroom. The only HTTP write is a server-identified human message. */
export function createChatroomRouter(service: ChatroomService): Router {
  const router = Router();
  router.get('/messages', (request: Request, response: Response) => {
    try {
      userSession(request, response, service);
      if (Object.keys(request.query).some(key => key !== 'after' && key !== 'limit' && key !== 'watch')) {
        throw new WorkbenchInputError('群消息查询包含未知参数');
      }
      const after = integer(request.query.after, 0);
      const limit = integer(request.query.limit, 100);
      response.json(service.read({ after, limit, watch: watch(request.query.watch) }));
    } catch (error) {
      response.status(error instanceof WorkbenchInputError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.post('/messages', (request: Request, response: Response) => {
    try {
      const sessionKey = userSession(request, response, service);
      const message = service.sendUser(sessionKey, request.body as ChatroomUserSendInput);
      response.status(201).json({ message: publicMessage(message) });
    } catch (error) {
      response.status(error instanceof WorkbenchInputError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  router.post('/tasks/:id/actions', async (request: Request, response: Response) => {
    try {
      const sessionKey = userSession(request, response, service);
      const taskId = request.params.id;
      if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 200) throw new WorkbenchInputError('协作任务 ID 不合法');
      const result = await service.taskAction(sessionKey, taskId, request.body as WorkTaskActionInput);
      response.json({ task: result.task, ...(result.message ? { message: publicMessage(result.message) } : {}) });
    } catch (error) {
      response.status(error instanceof WorkbenchInputError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return router;
}
