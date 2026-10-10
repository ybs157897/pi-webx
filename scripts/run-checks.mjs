/**
 * 并行 check 运行器：替代 package.json 里一整条 `&&` 门禁链。
 *
 * 链式的问题：第一个失败就中断，后面全看不到；串行等待，跑一轮十分钟。
 * 这里并发执行（默认 min(CPU, 8)，`CHECK_CONCURRENCY` 或 `--serial` 可调），
 * 全部跑完后统一汇报每个失败项的最后输出，再以非零码退出。
 *
 * 清单是全量扁平的：与旧链一一对应（含 check:chatroom 子链展开），
 * 外加两档 typecheck。新增门禁：在这个数组里登记一行。
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const BOOTSTRAP = ['--import', './scripts/check-bootstrap.mjs'];

/** [名称, 命令, 参数]；名称用于汇总，命令直接进 node_modules/.bin。 */
const CHECKS = [
  ['typecheck', 'tsc', ['--noEmit']],
  ['typecheck:workbench', 'tsc', ['--noEmit', '-p', 'tsconfig.workbench.json']],
  ['server-origin', 'tsx', ['scripts/check-server-origin.ts']],
  ['transcript', 'tsx', ['scripts/check-transcript.ts']],
  ['ask-card', 'tsx', ['scripts/check-ask-card.ts']],
  ['queue', 'tsx', ['scripts/check-queue.ts']],
  ['journal', 'tsx', ['scripts/check-journal.ts']],
  ['models-config', 'tsx', ['scripts/check-models-config.ts']],
  ['session-identity', 'tsx', ['scripts/check-session-identity.ts']],
  ['failure-copy', 'tsx', ['scripts/check-failure-copy.ts']],
  ['session-status', 'tsx', ['scripts/check-session-status.ts']],
  ['session-recency', 'tsx', ['scripts/check-session-recency.ts']],
  ['tool-card', 'node', [...BOOTSTRAP, 'scripts/check-tool-card.ts']],
  ['attachment-normalize', 'tsx', ['scripts/check-attachment-normalize.ts']],
  ['attachment-store', 'tsx', ['scripts/check-attachment-store.ts']],
  ['model-editor', 'tsx', ['scripts/check-model-editor.ts']],
  ['image-transport', 'tsx', ['scripts/check-image-transport.ts']],
  ['composer-images', 'tsx', ['scripts/check-composer-images.ts']],
  ['tool-presets', 'tsx', ['scripts/check-tool-presets.ts']],
  ['directory-picker-win32', 'tsx', ['scripts/check-directory-picker-win32.ts']],
  ['agent-definitions', 'tsx', ['scripts/check-agent-definitions.ts']],
  ['agent-definitions-api', 'tsx', ['scripts/check-agent-definitions-api.ts']],
  ['agent-definitions-ui', 'node', [...BOOTSTRAP, 'scripts/check-agent-definitions-ui.ts']],
  ['subagent-tool', 'tsx', ['scripts/check-subagent-tool.ts']],
  ['subagent-sdk', 'tsx', ['scripts/check-subagent-sdk.ts']],
  ['explore-codemode', 'tsx', ['scripts/check-explore-codemode.ts']],
  ['subagent-lifecycle', 'tsx', ['scripts/check-subagent-lifecycle.ts']],
  ['subagent-boundaries', 'tsx', ['scripts/check-subagent-boundaries.ts']],
  ['agent-team', 'tsx', ['scripts/check-agent-team.ts']],
  ['agent-team-journal', 'tsx', ['scripts/check-agent-team-journal.ts']],
  ['agent-team-inject', 'tsx', ['scripts/check-agent-team-inject.ts']],
  ['agent-team-windows-policy', 'tsx', ['scripts/check-agent-team-windows-policy.ts']],
  ['agent-team-sandbox', 'tsx', ['scripts/check-agent-team-sandbox.ts']],
  ['agent-team-sandbox-windows', 'tsx', ['scripts/check-agent-team-sandbox-windows.ts']],
  ['subagents-test-server', 'tsx', ['scripts/check-subagents-test-server.ts']],
  ['tool-preset-menu', 'node', [...BOOTSTRAP, 'scripts/check-tool-preset-menu.ts']],
  ['todos', 'tsx', ['scripts/check-todos.ts']],
  ['todo-tool', 'tsx', ['scripts/check-todo-tool.ts']],
  ['task-panel', 'node', [...BOOTSTRAP, 'scripts/check-task-panel.ts']],
  ['workbench-sqlite', 'tsx', ['scripts/check-workbench-sqlite.ts']],
  ['mutation-journal', 'tsx', ['scripts/check-mutation-journal.ts']],
  ['requirement-lifecycle', 'tsx', ['scripts/check-requirement-lifecycle.ts']],
  ['requirements-import', 'tsx', ['scripts/check-requirements-import.ts']],
  ['requirements-draft-idempotency', 'tsx', ['scripts/check-requirements-draft-idempotency.ts']],
  ['requirements-projection', 'tsx', ['scripts/check-requirements-projection.ts']],
  ['assistant-plans', 'tsx', ['scripts/check-assistant-plans.ts']],
  ['workbench-ui', 'node', [...BOOTSTRAP, 'scripts/check-workbench-ui.ts']],
  ['module-agent-send-ui', 'node', [...BOOTSTRAP, 'scripts/check-module-agent-send-ui.tsx']],
  ['requirement-trace-ui', 'node', [...BOOTSTRAP, 'scripts/check-requirement-trace-ui.tsx']],
  ['static-fallback', 'tsx', ['scripts/check-static-fallback.ts']],
  ['module-agent-send', 'tsx', ['scripts/check-module-agent-send.ts']],
  ['requirements-agent-context', 'tsx', ['scripts/check-requirements-agent-context.ts']],
  ['module-agent-profiles', 'tsx', ['scripts/check-module-agent-profiles.ts']],
  ['module-agent-knowledge', 'tsx', ['scripts/check-module-agent-knowledge.ts']],
  ['module-agent-sessions', 'tsx', ['scripts/check-module-agent-sessions.ts']],
  ['module-session-index', 'tsx', ['scripts/check-module-session-index.ts']],
  ['module-agent-mcp', 'tsx', ['scripts/check-module-agent-mcp.ts']],
  ['data-source-adapters', 'tsx', ['scripts/check-data-source-adapters.ts']],
  ['module-agent-http', 'tsx', ['scripts/check-module-agent-http.ts']],
  ['module-agent-settings', 'tsx', ['scripts/check-module-agent-settings.ts']],
  ['module-agent-skill-settings', 'tsx', ['scripts/check-module-agent-skill-settings.ts']],
  ['module-agent-prompt-polish', 'tsx', ['scripts/check-module-agent-prompt-polish.ts']],
  ['module-agent-project-context', 'tsx', ['scripts/check-module-agent-project-context.ts']],
  ['module-agent-workspaces', 'tsx', ['scripts/check-module-agent-workspaces.ts']],
  ['module-agent-workspace-settings', 'tsx', ['scripts/check-module-agent-workspace-settings.ts']],
  ['codes-workspace-binding', 'tsx', ['scripts/check-codes-workspace-binding.ts']],
  ['assistant-agent', 'tsx', ['scripts/check-assistant-agent.ts']],
  ['chatroom', 'tsx', ['scripts/check-chatroom.ts']],
  ['chatroom-consumption', 'tsx', ['scripts/check-chatroom-consumption.ts']],
  ['chatroom-coordination', 'tsx', ['scripts/check-chatroom-coordination.ts']],
  ['chatroom-runtime', 'tsx', ['scripts/check-chatroom-runtime.ts']],
  ['chatroom-work', 'tsx', ['scripts/check-chatroom-work.ts']],
  ['chatroom-persistent-runtime', 'tsx', ['scripts/check-chatroom-persistent-runtime.ts']],
  ['requirement-trace-runtime', 'tsx', ['scripts/check-requirement-trace-runtime.ts']],
  ['chatroom-ui', 'node', [...BOOTSTRAP, 'scripts/check-chatroom-ui.tsx']],
];

const serial = process.argv.includes('--serial');
const fromEnv = Number.parseInt(process.env.CHECK_CONCURRENCY ?? '', 10);
const concurrency = serial ? 1
  : Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv
    : Math.min(availableParallelism() ?? 4, 8);

const PER_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

function runOne([name, command, args]) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 .bin 里是 .cmd 垫片，需要 shell 解析；POSIX 直接命中 .bin。
      shell: process.platform === 'win32',
    });
    let output = '';
    const append = (chunk) => { output += chunk.toString(); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      output += `\n[run-checks] ${name} 超过 ${PER_CHECK_TIMEOUT_MS / 60000} 分钟，终止\n`;
      child.kill('SIGKILL');
    }, PER_CHECK_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      resolve({ name, code: code ?? 1, seconds, output });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ name, code: 1, seconds: '0', output: `${command} 无法启动：${error.message}` });
    });
  });
}

const pending = [...CHECKS];
const running = new Set();
const results = [];
let settled = 0;
for (const check of CHECKS) {
  while (running.size >= concurrency) await Promise.race(running);
  const task = runOne(check).then((result) => {
    settled += 1;
    const tag = result.code === 0 ? 'ok  ' : 'FAIL';
    process.stdout.write(`[${tag}] ${String(settled).padStart(2)}/${CHECKS.length} ${result.name} (${result.seconds}s)\n`);
    if (result.code !== 0) {
      const tail = result.output.trimEnd().split('\n').slice(-15).join('\n');
      process.stdout.write(`----- ${result.name} 输出末尾 -----\n${tail}\n------------------------------\n`);
    }
    running.delete(task);
    results.push(result);
  });
  running.add(task);
}
await Promise.all([...running]);

const failures = results.filter((result) => result.code !== 0);
if (failures.length > 0) {
  process.stdout.write(`\n[run-checks] ${failures.length}/${CHECKS.length} 项失败：${failures.map((f) => f.name).join('、')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n[run-checks] 全部 ${CHECKS.length} 项通过\n`);
}
