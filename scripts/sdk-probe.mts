import {
  ModelRuntime,
  createAgentSession,
  resolveCliModel,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

const runtime = await ModelRuntime.create();
const cli = resolveCliModel({ cliModel: 'zai-coding-cn/glm-5.3-flash', modelRuntime: runtime });
if (cli.error) {
  console.error('RESOLVE FAIL', cli.error);
  process.exit(1);
}
console.log('model:', cli.model.provider, cli.model.id, '| ctx:', cli.model.contextWindow);

const { session } = await createAgentSession({
  cwd: '/tmp',
  agentDir: getAgentDir(),
  model: cli.model,
  thinkingLevel: 'medium',
  modelRuntime: runtime,
});

const kinds = new Set();
session.subscribe((ev) => {
  kinds.add(ev.type);
  if (ev.type === 'message_update') {
    const d = ev.assistantMessageEvent;
    if (d.type === 'text_delta') process.stdout.write(d.delta);
  }
});

await session.prompt('Reply with exactly: probe-ok');
console.log('\n--- event kinds:', [...kinds].join(','));
console.log('messages:', session.messages.length, '| streaming:', session.isStreaming);
console.log('last text:', JSON.stringify(session.messages.at(-1)?.content?.[0]?.text?.slice(0, 80)));
session.dispose();
process.exit(0);
