import type { ChatroomService } from '../server/modules/chatroom/service';
import type { ChatroomRunner } from '../server/modules/chatroom/contracts';

/** Queue fixtures acknowledge the actual reply emitted by their simulated receiving member. */
export function registerChatroomFixtureRunner(room: ChatroomService, run: ChatroomRunner): () => void {
  return room.registerRunner(async message => {
    const member = message.recipientId ?? 'logs';
    room.prepareConsumptions(message.id, [member]);
    room.updateConsumption(message.id, member, 'processing');
    await run(message);
    room.updateConsumption(message.id, member, room.hasReply(message.id, member) ? 'consumed' : 'failed',
      '测试接收回合没有公开回复');
  });
}
