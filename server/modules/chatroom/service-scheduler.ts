import { AGENT_IDS, type AgentId } from '../../module-agents/contracts';
import type { ChatroomMessage } from './contracts';
import type { ChatroomStore } from './store';

const PAGE_SIZE = 200;
const TERMINAL = new Set(['consumed', 'skipped', 'failed']);

function pendingMembers(message: ChatroomMessage): Set<AgentId> {
  if (message.recipientId) return new Set([message.recipientId]);
  if (message.consumptions.length) return new Set(message.consumptions
    .filter(item => !TERMINAL.has(item.status)).map(item => item.agentId));
  return new Set(AGENT_IDS.filter(id => id !== message.senderId));
}

function intersects(left: ReadonlySet<AgentId>, right: ReadonlySet<AgentId>): boolean {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

/** Scan pending messages without letting queued work occupy an execution slot. */
export function nextEligibleDelivery(storage: ChatroomStore,
  active: ReadonlyMap<string, ChatroomMessage>): ChatroomMessage | undefined {
  const busy = new Set<AgentId>();
  let activeBroadcast = false;
  for (const [id, initial] of active) {
    const message = storage.byId(id) ?? initial;
    if (message.recipientId === null) activeBroadcast = true;
    for (const agent of pendingMembers(message)) busy.add(agent);
  }
  const reserved = new Set<AgentId>();
  let cursor = 0;
  while (true) {
    const page = storage.pendingAfter(cursor, PAGE_SIZE);
    for (const message of page) {
      const members = pendingMembers(message);
      if (message.recipientId === null) {
        if (!activeBroadcast && !intersects(members, busy) && !intersects(members, reserved)) return message;
        for (const agent of members) reserved.add(agent);
      } else if (!busy.has(message.recipientId) && !reserved.has(message.recipientId)) {
        return message;
      }
    }
    if (page.length < PAGE_SIZE) return undefined;
    cursor = page.at(-1)!.seq;
  }
}
