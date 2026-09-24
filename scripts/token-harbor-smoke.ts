import 'dotenv/config';
import {
  createGeminiLB,
  createRedis,
  KeyStore,
  maskKey,
  type StoredKey,
} from '../packages/gemini-lb/src';

/**
 * Live Token Harbor smoke test.
 *
 * It reads the enabled Token Harbor key(s) from REDIS, selects a configured
 * model (preferring a `:free` model), and sends one tiny request through the
 * same KeyStore → rate limiter → provider path used by the application.
 * The raw key is never printed or written to disk.
 */
async function main(): Promise<void> {
  const connection = createRedis(process.env.REDIS_URL);
  const keyStore = new KeyStore(connection.redis);
  const lb = createGeminiLB({
    redis: connection.redis,
    maxRetries: 0,
  });

  try {
    const keys = (await keyStore.list()).filter(
      (key) => key.enabled && key.provider === 'tokenharbor' && !key.backup,
    );
    if (keys.length === 0) {
      throw new Error(
        'No enabled primary Token Harbor key found. Add/enable one in the dashboard first.',
      );
    }

    const requestedModel = process.env.TOKENHARBOR_TEST_MODEL?.trim();
    const selected = selectTestKeyAndModel(keys, requestedModel);
    const result = await lb.generate({
      model: selected.model,
      prompt: 'Reply with exactly: pong',
      generationConfig: { max_tokens: 8 },
    });
    const text = result.text.trim();

    console.log(
      JSON.stringify(
        {
          ok: text.toLowerCase() === 'pong',
          text,
          provider: result.provider,
          model: result.model,
          key: maskKey(selected.key.key),
          keyId: result.keyId,
          backup: result.backup,
          baseUrl: selected.key.baseUrl,
        },
        null,
        2,
      ),
    );
  } finally {
    await lb.disconnect();
    await connection.redis.quit();
  }
}

function selectTestKeyAndModel(
  keys: StoredKey[],
  requestedModel?: string,
): { key: StoredKey; model: string } {
  for (const key of keys) {
    if (requestedModel) {
      if (key.models.some((model) => model.id === requestedModel)) {
        return { key, model: requestedModel };
      }
      continue;
    }

    const freeModel = key.models.find((model) => model.id.endsWith(':free'));
    if (freeModel) return { key, model: freeModel.id };
    if (key.models[0]) return { key, model: key.models[0].id };
  }

  const available = keys
    .flatMap((key) => key.models.map((model) => model.id))
    .filter((model, index, all) => all.indexOf(model) === index);
  throw new Error(
    requestedModel
      ? `Model "${requestedModel}" is not configured on an enabled Token Harbor key. Available: ${available.join(', ') || 'none'}`
      : `No models are configured on the enabled Token Harbor key(s). Available: ${available.join(', ') || 'none'}`,
  );
}

main().catch((error) => {
  console.error(`[token-harbor-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
