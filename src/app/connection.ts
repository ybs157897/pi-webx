/**
 * 桥接连接层的常量与辅助：连接状态的中文标签、错误归一化、失败的 pi 响应，
 * 以及启动时要读的配置（配置 + 该落哪个工作区）。
 */
import { api as bridge } from '../lib/api';
import type { ConnectionStatus } from '../lib/usePiSession';
import type { PiRpcResponse, ServerConfigResponse } from '../shared/protocol';

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: '未连接',
  connecting: '连接中',
  live: '已连接',
  reconnecting: '重连中',
  exited: '已结束',
  error: '连接失败',
};

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** pi's answer for a prompt that never made it onto the wire. */
export function failedPrompt(error: string): PiRpcResponse {
  return { type: 'response', command: 'prompt', success: false, error };
}

/**
 * 启动配置：bridge 的 `config`，加上这次启动该落在哪个工作区 —— 偏好里记过就
 * 沿用，否则用服务端启动时的默认目录。
 *
 * 启动副作用与引导失败屏的「重试」共用这一段（重试原本把同一串调用抄了第二遍），
 * 两处写入状态的次序不变：config → cwd → 记住 cwd。
 */
export async function loadBootConfig(
  bootCwd: string | undefined,
): Promise<{ config: ServerConfigResponse; cwd: string }> {
  const config = await bridge.config();
  const cwd = bootCwd && bootCwd.length > 0 ? bootCwd : config.defaultCwd;
  return { config, cwd };
}
