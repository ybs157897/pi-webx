/**
 * Transcript reducer: folds pi's event stream into the UI's transcript model.
 *
 * The contract (types + signatures) lives in `src/shared/transcript.ts`; this
 * module is the implementation. Two entry points:
 *
 *   - `applySnapshot(state, messages)` rebuilds `entries` from a `get_messages`
 *     reply (connect / reconnect / session switch)
 *   - `applyPiEvent(state, event)` folds one live pi event in incrementally
 *
 * Both are pure: the input state and its nested arrays/objects are never
 * mutated, and unchanged parts are structurally shared. Nothing here performs
 * I/O; the only ambient read is `Date.now()` for the `at` / `startedAt` /
 * `endedAt` timestamps of new entries (allowed by the contract).
 *
 * Event semantics follow pi's RPC docs (`pi-coding-agent/docs/rpc.md`, "Events"
 * and "Types") and the wire types in `src/shared/protocol.ts`. Two properties
 * that drive most of the design:
 *
 *   - `tool_execution_update.partialResult` is *cumulative*, not a delta: it
 *     REPLACES a run's output. `bash_execution_update.delta` is a real delta and
 *     APPENDS to the matching `bash` entry.
 *   - `message_update.assistantMessageEvent` carries deltas only (no cumulative
 *     message); `message_end.message` is authoritative and is where an
 *     assistant entry is finalised.
 *
 * Nothing in here is allowed to throw: it consumes a live stream, and an
 * exception would take the UI down with it.
 */

/**
 * Re-exported from the shared contract so consumers have a single import site.
 * Rebuilt state: `createTranscript()` -> snapshot -> stream of pi events.
 */
export { createTranscript } from '../../shared/transcript';

/*
 * The implementation is split by responsibility, and this barrel is the
 * module's public surface - the same six exports as before the split:
 *
 *   guards.ts     unknown-value accessors      entries.ts   entry ids / surgery
 *   blocks.ts     content-block parsing        turns.ts     message state machine
 *   tool-runs.ts  tool-run lifecycle           notices.ts   retry / error notices
 *   fold.ts       turn folding                 snapshot.ts  history rebuild
 *   events.ts     pi event reduction           echo.ts      optimistic echo
 */
export { addEcho, retireEcho } from './echo';
export { applyPiEvent } from './events';
export { answerIndexOf } from './fold';
export { applySnapshot } from './snapshot';
