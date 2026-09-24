# Agent Team P5：macOS 编码工具隔离

Status: implemented and exercised on the current macOS host in `feat/user-subagents`; not committed or pushed in this turn. Windows has a separate native AppContainer implementation whose runtime acceptance is still **NOT RUN**; Linux fails closed.

## Boundary

- The orchestrator and every Team member keep their model session and provider credentials in the pi-webx host. Their eight built-in coding tools (`read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`) are overridden with per-call tools that run under macOS Seatbelt via `sandbox-exec`.
- The sandbox child receives one tool name, its validated parameters, and the canonical workspace path over stdin. Its environment contains no inherited provider keys, auth path, proxy variables, or management credentials. The child loads no model runtime.
- The profile allows writes only under the canonical workspace and a private per-call scratch directory. Reads of the user's home and OS temp directory are denied except for the workspace, the tool host, Node, and the required dependency tree. The Agent configuration directory is explicitly denied. Tool-process network access, signalling other processes, AppleEvents, and Launch Services app opening are denied; provider calls stay in the host.
- Team mode loads no extensions. Its two member-only Team tools still execute in the host with their existing identity and ownership checks. Ordinary non-Team sessions and one-shot subagents retain their existing tool path.
- If the OS sandbox is absent, the workspace overlaps the Agent store, or the profile cannot run, a Team operation fails. There is no unisolated fallback.
- A Team workspace also cannot overlap this pi-webx checkout. Otherwise writing host source during development could make a watcher or later restart execute model-authored code outside the sandbox.
- Before a Team starts, the host runs one cached Seatbelt preflight for that workspace and Agent store: a scratch file must be readable and a separate OS-temp file must be denied. A policy that fails either side is rejected.
- The isolated `grep` and `find` tools use locally installed `rg` and `fd`. They are required at Team startup because the tool process has no network access to download them.

## Verification

- `scripts/check-agent-team-sandbox.ts` executes real SDK tools in the sandbox: workspace read/write/edit/bash/grep/find/ls succeed; direct and symlink access to the definition store fail; an unrelated symlink target outside the workspace also cannot be overwritten; Bash cannot read or write the store; `127.0.0.1`, `0.0.0.0`, and `localhost` cannot reach a live local management listener; a sandboxed process cannot signal a host process. The real SDK registry uses the overridden tools and does not evaluate an extension fixture.
- `scripts/check-agent-team.ts` checks the orchestrator's own `read` tool against a protected file and verifies the Team loader skips extension code.
- A bounded live dispatch returned runtime model metadata `{provider:"cmdc",id:"deepseek/deepseek-v4.1-flash"}` and settled a member as `idle`; its effective tools included `read`, `bash`, `write`, and the two member Team tools. The member used coding tools to write `TEAM_P5_OK` in a disposable workspace. This final run used the profile with tool-process network disabled.
- `npm run check:team-live` repeated credential-backed acceptance in a disposable workspace: the member wrote the exact marker, sent a Team message, and the next real Flash turn read it. A second real streaming dispatch produced a worker-only random code; the lead saw it through exactly one Team custom message and echoed it in its answer. Returned member metadata identified the configured Flash model.

## Limits

- `sandbox-exec` is marked deprecated by macOS. This implementation is specific to the current macOS host. Windows uses a separate native LPAC AppContainer path, pending Windows execution; Linux has no Team isolation backend.
- These checks establish the listed file, loopback, signal, and SDK tool boundaries on this host. They are not a complete adversarial security audit or a power-loss test.
- The roadmap's multi-provider model validation remains open; the user-selected execution model in this run was DeepSeek Flash.
