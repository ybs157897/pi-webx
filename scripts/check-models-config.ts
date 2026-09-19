/**
 * Self-check for the models.json layer (`server/models-config.ts`) and the
 * smart-configuration lookup (`server/model-suggest.ts`).
 *
 * Runs against a throwaway HOME so the user's real `~/.pi/agent/models.json` is
 * never touched:
 *
 *   npx tsx scripts/check-models-config.ts
 *
 * Covers: native field round-trip (thinkingLevelMap), the `piWebx` extension
 * block, preservation of fields this code does not model (cost/compat/…), the
 * catalog-hiding read used by the picker, and pi's own tolerance of the
 * extension keys (a real ModelRuntime load).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error: unknown) => {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error instanceof Error ? error.message : String(error));
    });
}

// The config path follows pi's own agent dir, which is resolved at module load,
// so HOME must move before the first import of the module under test.
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'piwebx-models-'));
process.env['HOME'] = sandbox;
const agentDir = path.join(sandbox, '.pi', 'agent');
mkdirSync(agentDir, { recursive: true });

const modelsConfig = await import('../server/models-config');
const { suggestModelFields } = await import('../server/model-suggest');

async function main(): Promise<void> {
  const configPath = modelsConfig.CONFIG_PATH;
  assert.ok(configPath.startsWith(sandbox), `sandboxed config path: ${configPath}`);

  await check('provider + model round-trip every field, unknown keys preserved', async () => {
    const first = await modelsConfig.upsertProvider('demo', {
      name: 'Demo',
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      apiKey: { value: 'sk-test' },
      piWebx: { enabled: true },
      models: [
        {
          id: 'demo-large',
          name: 'Demo Large',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          thinkingLevelMap: { off: 'off', high: 'high', max: 'max', minimal: null },
          piWebx: {
            enabled: true,
            inputFormat: { video: true, pdf: true },
            capabilities: { jsonSchemaOutput: true, nativeWebSearch: false },
            reasoningLevelMap: 'reasoningLevel == "off" ? { enabled: false } : {}',
          },
        },
      ],
    });
    const model = first.providers['demo']?.models[0];
    assert.equal(model?.thinkingLevelMap?.['max'], 'max');
    assert.equal(model?.thinkingLevelMap?.['minimal'], null);
    assert.equal(model?.piWebx?.inputFormat?.video, true);
    assert.equal(model?.piWebx?.capabilities?.jsonSchemaOutput, true);
    assert.equal(typeof model?.piWebx?.reasoningLevelMap, 'string');
    assert.equal(first.providers['demo']?.piWebx?.enabled, true);

    // Simulate fields pi-webx does not model, then edit the model again: they
    // must survive the rebuild (the old code dropped them). The shapes matter:
    // pi schema-checks models.json and rejects the WHOLE file on a violation,
    // so the fixture uses entries its schema accepts (a cost object is only
    // valid with all four rates, samplingParams is a free-form record).
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    raw.providers['demo']!.models[0]!['cost'] = {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    };
    raw.providers['demo']!.models[0]!['samplingParams'] = { temperature: 0.5 };
    writeFileSync(configPath, JSON.stringify(raw, null, 2));

    const second = await modelsConfig.upsertModel('demo', {
      id: 'demo-large',
      name: 'Demo Large v2',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      thinkingLevelMap: { off: 'off', high: 'high' },
      piWebx: { inputFormat: { video: true }, reasoningLevelMap: '{}' },
    });
    const edited = second.providers['demo']?.models[0];
    assert.equal(edited?.name, 'Demo Large v2');
    assert.deepEqual(edited?.thinkingLevelMap, { off: 'off', high: 'high' });

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const stored = onDisk.providers['demo']!.models[0]!;
    assert.deepEqual(
      stored['cost'],
      { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      'unmodelled cost survives',
    );
    assert.deepEqual(
      stored['samplingParams'],
      { temperature: 0.5 },
      'unmodelled samplingParams survives',
    );
    assert.deepEqual(stored['thinkingLevelMap'], { off: 'off', high: 'high' });
    assert.ok(stored['piWebx'], 'piWebx block written');
    assert.equal((stored['piWebx'] as Record<string, unknown>)['enabled'], undefined,
      'empty extension keys are not fabricated');
  });

  await check('catalog visibility follows piWebx.enabled', async () => {
    await modelsConfig.upsertModel('demo', { id: 'demo-hidden', reasoning: false, piWebx: { enabled: false } });
    const { disabledProviders, disabledModels } = modelsConfig.readCatalogVisibility();
    assert.equal(disabledProviders.has('demo'), false);
    assert.equal(disabledModels.get('demo')?.has('demo-hidden'), true);
    assert.equal(disabledModels.get('demo')?.has('demo-large'), false);

    await modelsConfig.upsertProvider('demo-off', {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-completions',
      piWebx: { enabled: false },
      models: [{ id: 'x' }],
    });
    const next = modelsConfig.readCatalogVisibility();
    assert.equal(next.disabledProviders.has('demo-off'), true);
  });

  await check('smart configuration matches pi’s bundled catalogue by id', () => {
    const known = suggestModelFields('gemini-2.5-flash');
    assert.ok(known.match, 'a pi catalogue model is found');
    assert.match(known.match.provider, /google/, 'matched to a google family entry');
    assert.ok((known.match.contextWindow ?? 0) > 0, 'carries a context window');
    const miss = suggestModelFields('definitely-not-a-real-model-id');
    assert.equal(miss.match, null);
  });

  await check('pi itself loads the file with piWebx keys present', async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const runtime = await ModelRuntime.create();
    await runtime.refresh({ allowNetwork: false });
    const model = runtime.getModel('demo', 'demo-large') as { id?: string } | undefined;
    const providers = runtime.getProviders().map((entry: { id: string }) => entry.id);
    assert.equal(
      model?.id,
      'demo-large',
      [
        'pi parsed the entry, extension keys and all',
        `runtime error: ${String(runtime.getError())}`,
        `demo present: ${String(providers.includes('demo'))} (${providers.length} providers)`,
      ].join(' · '),
    );
  });

  await check('an external edit to models.json is picked up without a restart', async () => {
    const { PiHost } = await import('../server/pi/host');
    const { resolveCliModel } = await import('@earendil-works/pi-coding-agent');

    // Written straight to the file, the way an editor or the `pi` CLI does it:
    // nothing in this process is told about the change.
    const writeConfig = (contextWindow: number): void => {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            providers: {
              reload: {
                baseUrl: 'https://api.example.com/v1',
                api: 'openai-completions',
                apiKey: 'sk-test',
                models: [{ id: 'sized', contextWindow }],
              },
            },
          },
          null,
          2,
        ),
      );
    };
    writeConfig(1000);

    const host = new PiHost();
    try {
      // Stamps the file as loaded (the runtime already exists at this point).
      await host.syncModelConfig();
      const runtime = await host.getModelRuntime();
      const before = resolveCliModel({ cliModel: 'reload/sized', modelRuntime: runtime });
      assert.equal(before.model?.contextWindow, 1000, 'the declared window is what pi resolved');

      // The new value is a different *length*, so the stamp differs even if the
      // rewrite lands inside the same clock tick — which is why size is in it.
      writeConfig(123456);

      assert.equal(await host.syncModelConfig(), true, 'a changed file must trigger a reload');
      const after = resolveCliModel({ cliModel: 'reload/sized', modelRuntime: runtime });
      assert.equal(
        after.model?.contextWindow,
        123456,
        'the runtime must serve the new value without a restart',
      );

      assert.equal(await host.syncModelConfig(), false, 'an unchanged file must not reload');
    } finally {
      await host.disposeAll();
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
  // The sandbox lives under the OS temp dir; leaving it makes failures debuggable.
  console.log(`sandbox: ${sandbox}`);
}

void main();
