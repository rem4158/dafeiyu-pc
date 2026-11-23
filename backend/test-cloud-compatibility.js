// Strict in-memory provider doubles only: no sockets, credentials or live models.
const assert = require('node:assert/strict');
const { chatCloud, chatCloudStream, getCloudTestOptions } = require('./electron/brain/cloud');

const prompt = [{ role: 'user', content: '连接测试，请只回复 OK。' }];
const privateBody = 'private-provider-body-and-key SECRET';
const configured = (model, baseUrl = 'https://api.openai.com/v1') => ({
  cloud: { baseUrl, model, apiKey: 'fake-test-key' },
});
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
const completed = () => json({ choices: [{ message: { content: 'OK' } }] });

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const call = { url: String(url), options, body: JSON.parse(options.body) };
    calls.push(call);
    return handler(call);
  };
  try { await run(calls); }
  finally { globalThis.fetch = original; }
}

function strictOpenAI(call) {
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.Authorization, 'Bearer fake-test-key');
  assert.equal(call.body.stream, true);
  if (Object.hasOwn(call.body, 'max_tokens') || Object.hasOwn(call.body, 'temperature')) {
    return json({ error: { code: 'unsupported_parameter', message: privateBody } }, 400);
  }
  return completed();
}

async function assertPrivateFailure(run, calls) {
  await assert.rejects(run, error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(privateBody));
    assert.ok(!JSON.stringify(error).includes(privateBody));
    return true;
  });
  assert.equal(calls.length, 1, 'failed requests must not silently retry or switch endpoints');
}

async function main() {
  for (const model of ['gpt-6.1-terra', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna',
    'gpt-5', 'gpt-5.1', 'gpt-5.6-terra', 'o1', 'o3', 'o4-mini']) {
    const config = configured(model);
    const probe = getCloudTestOptions(config);
    assert.equal(probe.max_tokens, 1024, 'reasoning probes leave room for non-visible tokens');
    assert.equal(probe.timeoutMs, 30000);
    await withFetch(strictOpenAI, async calls => {
      assert.equal(await chatCloud(config, prompt, probe), 'OK', model);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.model, model);
      assert.equal(calls[0].body.max_completion_tokens, 1024);
      assert.deepEqual(calls[0].body.messages, prompt);
    });
  }

  // Ordinary chat and other capped consumers share the same compatibility path.
  await withFetch(strictOpenAI, async calls => {
    assert.equal(await chatCloud(configured('gpt-6.1-terra'), prompt), 'OK');
    assert.ok(!Object.hasOwn(calls[0].body, 'max_tokens'));
    assert.ok(!Object.hasOwn(calls[0].body, 'max_completion_tokens'));
    assert.ok(!Object.hasOwn(calls[0].body, 'reasoning_effort'), 'normal chat preserves provider reasoning defaults');
    assert.equal(await chatCloud(configured('gpt-6.1-terra'), prompt, { max_tokens: 180, temperature: .1 }), 'OK');
    assert.equal(calls[1].body.max_completion_tokens, 180);
  });

  await withFetch(call => {
    assert.equal(strictOpenAI(call).status, 200, 'streaming must use the same compatible request parameters');
    const chunks = [
      'data: {"choices":[{"delta":{"content":"O"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"K"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({ start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, async calls => {
    const deltas = [];
    assert.equal(await chatCloudStream(configured('gpt-6.1-terra'), prompt, delta => deltas.push(delta)), 'OK');
    assert.deepEqual(deltas, ['O', 'K']);
    assert.equal(calls.length, 1);
  });

  for (const model of ['deepseek-chat', 'gpt-4.1']) {
    const config = configured(model, 'https://api.deepseek.com/v1/chat/completions/');
    const probe = getCloudTestOptions(config);
    assert.equal(probe.max_tokens, 16);
    assert.equal(probe.timeoutMs, 15000);
    await withFetch(call => {
      assert.equal(call.url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(call.body.max_tokens, 16);
      assert.equal(call.body.temperature, 0);
      assert.ok(!Object.hasOwn(call.body, 'max_completion_tokens'));
      return completed();
    }, async () => assert.equal(await chatCloud(config, prompt, probe), 'OK'));
  }
  await withFetch(call => {
    assert.equal(call.body.temperature, .85);
    return completed();
  }, async () => assert.equal(await chatCloud(configured('deepseek-chat'), prompt), 'OK'));

  await withFetch(call => {
    assert.equal(call.url, 'https://api.xiaomimimo.com/v1/chat/completions');
    assert.equal(call.options.headers['api-key'], 'fake-test-key');
    assert.equal(call.body.max_tokens, 64);
    assert.equal(call.body.max_completion_tokens, 64);
    assert.equal(call.body.temperature, .2);
    assert.deepEqual(call.body.thinking, { type: 'disabled' });
    return completed();
  }, async () => assert.equal(await chatCloud(configured('mimo-v2-flash', 'https://api.xiaomimimo.com/v1'),
    prompt, { max_tokens: 64, temperature: .2 }), 'OK'));

  for (const status of [400, 401, 403, 404, 422, 429, 500]) {
    await withFetch(() => json({ error: { code: 'unsupported_parameter', param: 'max_tokens', message: privateBody } }, status),
      calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt), calls));
  }
  await withFetch(() => new Response(privateBody, { status: 502 }),
    calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt), calls));
  await withFetch(() => { throw new TypeError(privateBody); },
    calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt), calls));
  await withFetch(() => json({ choices: [{ message: { content: '' } }] }),
    calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt), calls));
  await withFetch(() => new Response('data: ' + JSON.stringify({ error: { code: 'invalid_api_key', message: privateBody } }) + '\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }),
  calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt), calls));

  const abortingFetch = call => new Promise((resolve, reject) => {
    if (call.options.signal.aborted) return reject(new DOMException(privateBody, 'AbortError'));
    call.options.signal.addEventListener('abort', () => reject(new DOMException(privateBody, 'AbortError')), { once: true });
  });
  await withFetch(abortingFetch, calls => assertPrivateFailure(() => chatCloud(configured('gpt-6.1-terra'), prompt,
    { timeoutMs: 10 }), calls));
  await withFetch(abortingFetch, async calls => {
    const controller = new AbortController();
    const pending = chatCloud(configured('gpt-6.1-terra'), prompt, { signal: controller.signal });
    controller.abort();
    await assertPrivateFailure(() => pending, calls);
  });
  console.log('cloud-compatibility: PASS (strict GPT requests, JSON/SSE, legacy providers, private errors, no retry, abort/timeout)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
