# Agent Team P5：Windows 原生工具隔离

Status: implementation present on `feat/user-subagents`; **Windows runtime acceptance NOT RUN**. No Docker, VM, WSL, or separately installed sandbox runtime is required by the product. Only Windows x64 has pinned search-tool provisioning in this change.

## Boundary and startup

- Team coding tools run through the `@landstrip/landstrip-api@0.19.2` bundled native Windows executable under LPAC AppContainer. The model session and provider credentials remain in pi-webx. Every call launches one isolated tool host; its environment excludes inherited credentials and proxy settings.
- The policy grants read access to the canonical workspace, private scratch, Node executable directory, application dependencies, tool host, and pinned search tools. Writes are limited to the workspace and scratch. It grants neither network capability nor loopback. The workspace must be on a local drive and cannot overlap the user directory, Agent store, or the running app checkout.
- Startup checks the native executable, the SHA-256 hashes of `rg.exe` and `fd.exe`, and `landstrip windows status`. A host configured for Landstrip's restricted-user backend is rejected because `windows.appContainerMode: lpac` does not select that backend. First use also runs a real allowed/denied file-read probe. No unisolated fallback is provided.
- `npm ci` downloads fixed Windows x64 rg/fd release archives, checks both archive and executable hashes, and stores them under `node_modules/.cache/pi-webx-team-tools`. The downloaded tools are executables bundled with the app installation, not a user-installed runtime. Both archive and executable hashes were checked against actual downloads on macOS; Windows installation itself is pending.
- Cancellation first sends a frame to the sandbox tool host, letting it stop child shell commands and exit normally. A two-second force stop remains as a fallback. Landstrip's source places the sandboxed process in a Job Object with kill-on-close; forced termination of Landstrip may leave temporary AppContainer ACL grants because its normal cleanup does not run. Windows acceptance checks ACL cleanup after normal and cancelled calls. This residual forced-stop cleanup risk remains open until native evidence or a different lifecycle mechanism closes it.

## Acceptance matrix

| Surface | Current result | Evidence required on Windows |
| --- | --- | --- |
| Policy shape and backend refusal | Static PASS on macOS | `npm run check` validates the pure policy and status rules. |
| `npm ci` native binary and rg/fd provisioning | NOT RUN | Install on Windows x64; verify hashes and executable launch. |
| Workspace coding tools | NOT RUN | `scripts/check-agent-team-sandbox-windows.ts` runs write/edit/read/PowerShell/grep/find/ls. |
| Agent store, unrelated junction target, loopback, host process negative cases | NOT RUN | Same script verifies real denial and unchanged protected content. |
| Cancellation and ACL cleanup | NOT RUN | Same script checks prompt settlement and no new AppContainer SID on tested ACL roots. |
| Windows Edge Team UI | NOT RUN | `npm run check:team-browser` validates creation, panel, mobile layout, and restored journal. |
| Real model dispatch and lead message injection | NOT RUN | Run `npm run check:team-live` on a Windows test host with a configured DeepSeek Flash provider; it checks the returned provider/model metadata, durable Team journal, and both idle and streaming message visibility. |

The matrix CI job in `.github/workflows/agent-team-platforms.yml` can run the first six surfaces after the branch is available to GitHub Actions. It has no model credential and cannot establish the final row. Do not mark Windows P5 accepted from macOS checks or CI configuration alone.

## Distribution notices

- `@landstrip/landstrip-api@0.19.2`: Apache-2.0; bundled `@landstrip/landstrip-win32-x64@0.19.2` native executable: LGPL-3.0-or-later. The API package includes an Apache license file; the native package does **not** include the LGPL text. A copy from the exact upstream `0.19.2` tag is kept at `docs/licenses/landstrip-LGPL-3.0-or-later.txt`. Source: `https://github.com/landstrip/landstrip/tree/0.19.2`.
- Windows rg/fd binaries are downloaded from their upstream versioned releases and hash-verified during installation. Their release archives contain license files; the provisioning script copies them alongside the executables. Release sources are recorded in `scripts/setup-team-windows-tools.mjs`. An installer that contains Landstrip still needs to carry the LGPL notice and satisfy its corresponding-source obligations.
