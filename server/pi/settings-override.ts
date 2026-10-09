/**
 * 模块 Agent 会话的 SettingsManager 覆盖层：统一注入 compaction（pi 内置自动
 * 上下文压缩）阈值，并保证注入不被 `reload()` 冲掉。
 *
 * 为什么是「代理 + reload 重放」而不是一次性 `applyOverrides`：
 * `SettingsManager.applyOverrides()` 只是把覆盖深合并进它自己持有的 `settings`，
 * 而 `reload()` 会重新读 global + project 两层设置并**重建** `settings`（顺带清空
 * modifiedFields）——一次性注入的 compaction 会被 reload 悄悄抹掉。谁会 reload：
 * `DefaultResourceLoader.reload()`（装配期的 moduleLoader 就调它）与
 * `AgentSession.reload()`（扩展/命令触发的重载，见 dist/core/agent-session.js）。
 * 所以代理的 `reload()` 先转发给内层，再把覆盖重放上去。
 *
 * 代理的其余成员一律以**内层实例为 `this`** 调用：设置状态只存在于内层，代理不
 * 持有副本，会话里任何 `set*` 写法、内层 reload 之后的读取都落在同一份 settings 上，
 * 不会出现两份状态互相遮挡。主会话、团队会话与子智能体装配不经过这里。
 */
import type { CompactionSettings, SettingsManager } from '@earendil-works/pi-coding-agent';

/**
 * 模块会话统一的 compaction 阈值。
 *
 * 需求 Agent 的模型上下文窗口是 1,000,000（`~/.pi/agent/models.json`），按 pi 默认的
 * reserveTokens 16384 / keepRecentTokens 20000，要涨到约 98.4 万 token 才触发压缩，
 * 形同虚设。这里把保留区抬到 65536、近端保留抬到 32768：压缩在上下文真正变长时发生，
 * 同时保留足够近的对话不被摘要吞掉。
 */
export const MODULE_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 65536,
  keepRecentTokens: 32768,
} as const;

/** 注入的 compaction 覆盖形状（与 `Settings.compaction` 同源）。 */
export type ModuleCompactionOverrides = Pick<
  CompactionSettings,
  'enabled' | 'reserveTokens' | 'keepRecentTokens'
>;

/**
 * 返回一个以 `inner` 为内层、带 compaction 覆盖的 SettingsManager 代理。
 *
 * 立即注入一次；此后任何经代理的 `reload()` 都会在内层重读文件之后重放覆盖，
 * 因此装配期的 `moduleLoader.reload()`、`AgentSession.reload()` 都不会把阈值冲掉。
 */
export function withCompactionDefaults(
  inner: SettingsManager,
  overrides: ModuleCompactionOverrides = MODULE_COMPACTION_SETTINGS,
): SettingsManager {
  const replay = (): void => {
    // 每次重放都用新对象：不让覆盖值被内层 settings 引用后发生别名共享。
    inner.applyOverrides({ compaction: { ...overrides } });
  };
  replay();
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'reload') {
        return async (): Promise<void> => {
          await target.reload();
          replay();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
