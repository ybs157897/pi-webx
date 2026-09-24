# Agent Team P4：团队面板与会话恢复

Status: implemented on `feat/user-subagents` in the current worktree; not committed or pushed in this turn.

## What changed

- A new conversation can be switched to **Agent Team** before the first message. The header menu also offers “新建 Agent Team”. The create request carries `teamMode: true`.
- The Team drawer reads `GET /api/teams/<sessionId>` and shows members, tasks, messages, bounded member results, delivery state, and a cooperative “停止成员” action. It polls only while open. Model-authored text is rendered as plain text under `untrusted` fields.
- A resumed transcript reattaches its journaled Team by parent session id. It does not create a second Team when `teamMode: true` is sent again. Pending inbox items are reconsidered after the live session is attached.
- The Team result projection includes `untrustedResult: { text, truncated }`; the same 32,000-character bound used by `wait_team` applies.
- At widths up to 640px the sidebar starts in its rail state, leaving the Team button reachable. The rail can still be expanded without changing the saved desktop preference.

## Verification

- `scripts/check-agent-team-journal.ts`: stored transcript resumed with and without an explicit Team hint, original Team/task/result retained, one journal file; 17/17 passed.
- `npm run typecheck`, `npm run check`, `npm run build`, and `git diff --check`: final results are recorded in the turn summary.
- Browser acceptance on a built production UI at 1440px and 390px: mode selection set `?team=1`; Team drawer displayed a journal-replayed member result, task, and message; reload kept the Team visible. The 390px check waits for layout to settle and verifies the drawer and title actually fit the viewport, as well as the absence of document-level horizontal overflow. A mocked running member exercised the confirmation and cooperative cancellation POST. A browser-scripted first send created a Team without making a model request.

## Boundaries

- A Team with no assistant turn still has no pi transcript file. Its journal projection can be read after a restart, but that empty conversation cannot be resumed by `sessionId`.
- The panel is a host projection with a cancel action. Task edits remain model-side Team tools; the panel does not add a second task mutation API.
- Real Flash member-to-lead messages passed both the idle `turn-started` and streaming `steered` paths. `npm run check:team-live` confirmed one visible custom entry per message and that the next real model answer contained a code sent only in the streaming Team message, not in the member's tool result. Internal drain micro-order and systematic prompt-interpretation effects remain outside this acceptance sample.
