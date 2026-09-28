/**
 * One tool run, drawn by whichever card owns it.
 *
 * Three call sites render a run (a step inside an assistant message, a standalone
 * tool result, and the shell's own card) and all of them must agree: a question
 * is a question wherever it appears; Skill/MCP calls share their capability card.
 * Keeping the choice in one place is what stops the ask card from being a
 * special case at only one of them.
 */

import type { ToolRun } from '../shared/transcript';
import { askCardFromRun } from '../lib/ask-card';
import { AskQuestionCard } from './AskQuestionCard';
import { ToolCard } from './ToolCard';
import { capabilityCall } from '../lib/capability-call';
import { CapabilityToolCard } from './CapabilityToolCard';

export function ToolRunView({ run }: { run: ToolRun }) {
  const ask = askCardFromRun(run);
  if (ask !== null) return <AskQuestionCard card={ask} />;
  const capability = capabilityCall(run);
  if (capability !== null) return <CapabilityToolCard run={run} call={capability} />;
  return <ToolCard run={run} />;
}
