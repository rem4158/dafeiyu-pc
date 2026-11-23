// Native tools against in-memory HTTP doubles only; no models, QQ or saved data.
const assert = require('node:assert/strict');
const { chatCloudTurn } = require('./electron/brain/cloud');
const { chatOllamaTurn } = require('./electron/brain/ollama');
const { chatWithTools, parseMultiReply } = require('./electron/brain/chat');

const secret = 'PRIVATE_PROVIDER_BODY_AND_KEY';
const prompt = [{ role: 'system', content: 'same persona' }, { role: 'user', content: 'send a greeting' }];
const tools = [{ type: 'function', function: { name: 'fixture_echo', description: 'Send text', parameters: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
} } }];
const configured = (model = 'gpt-5.6-terra', baseUrl = 'https://api.openai.com/v1') => ({
  provider: 'cloud', cloud: { model, baseUrl, apiKey: 'fake-key' },
  ollama: { model: 'fake-ollama', baseUrl: 'http://127.0.0.1:11434' },
});
const json = (data, status = 200) => new Response(JSON.stringify(data), { status,
  headers: { 'content-type': 'application/json' } });
const message = content => json({ choices: [{ message: { role: 'assistant', content } }] });
const call = (id = 'call_1', args = '{"text":"hello"}', name = 'fixture_echo') => ({
  id, type: 'function', function: { name, arguments: args },
});
const invoking = (calls = [call()]) => json({ choices: [{ message: {
  role: 'assistant', content: null, reasoning_content: 'provider transcript', tool_calls: calls,
} }] });

async function withFetch(handler, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const request = { url: String(url), options, body: JSON.parse(options.body) };
    calls.push(request);
    return handler(request, calls.length - 1);
  };
  try { await run(calls); } finally { global.fetch = original; }
}

async function main() {
  // Actual Chat Completions request/transcript, same configured model and persona.
  let executed = 0;
  await withFetch((request, index) => {
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.body.stream, false);
    assert.equal(request.body.model, 'gpt-5.6-terra');
    assert.deepEqual(request.body.tools, tools);
    assert.ok(!Object.hasOwn(request.body, 'temperature'));
    assert.ok(!Object.hasOwn(request.body, 'max_tokens'));
    if (!index) return invoking();
    assert.deepEqual(request.body.messages.slice(0, 2), prompt);
    assert.equal(request.body.messages[2].reasoning_content, 'provider transcript');
    assert.deepEqual(request.body.messages[2].tool_calls, [call()]);
    assert.equal(request.body.messages[3].tool_call_id, 'call_1');
    assert.ok(!Object.hasOwn(request.body.messages[3], 'name'), 'cloud tool transcript uses the standard schema');
    assert.equal(JSON.parse(request.body.messages[3].content).ok, true);
    return message('[{"text":"sent","delay":0},{"text":"done","delay":1200}]');
  }, async requests => {
    const raw = await chatWithTools(configured(), prompt, { tools, executeTool: async tool => {
      executed++;
      assert.deepEqual(tool, { id: 'call_1', name: 'fixture_echo', arguments: { text: 'hello' } });
      return { ok: true, result: { messageId: 'test-only' } };
    } });
    assert.equal(parseMultiReply(raw).messages.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(executed, 1);
    assert.deepEqual(prompt, [{ role: 'system', content: 'same persona' }, { role: 'user', content: 'send a greeting' }]);
  });

  // Token/temperature policy is also retained by the new turn path.
  for (const [model, baseUrl] of [['deepseek-chat', 'https://api.deepseek.com/v1'],
    ['gpt-5.6-terra', 'https://api.openai.com/v1'], ['mimo-v2-flash', 'https://api.xiaomimimo.com/v1']]) {
    await withFetch(request => {
      if (model.startsWith('gpt-5')) {
        assert.equal(request.body.max_completion_tokens, 240);
        assert.ok(!Object.hasOwn(request.body, 'temperature'));
      } else {
        assert.equal(request.body.max_tokens, 240);
        assert.equal(request.body.temperature, .2);
      }
      if (model.startsWith('mimo')) {
        assert.deepEqual(request.body.thinking, { type: 'disabled' });
        assert.equal(request.body.max_completion_tokens, 240);
        assert.equal(request.options.headers['api-key'], 'fake-key');
      }
      return message('OK');
    }, async () => assert.equal((await chatCloudTurn(configured(model, baseUrl), prompt,
      { tools, max_tokens: 240, temperature: .2 })).content, 'OK'));
  }

  // Official GPT-6 tools preserve reasoning with Responses, without forcing none.
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']) {
    const output = [{ id: 'reasoning_1', type: 'reasoning', encrypted_content: 'opaque-private-transcript', summary: [] },
      { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'fixture_echo', arguments: '{"text":"hello"}' }];
    await withFetch((request, index) => {
      assert.equal(request.url, 'https://api.openai.com/v1/responses');
      assert.equal(request.body.model, model);
      assert.equal(request.body.store, false);
      assert.ok(!Object.hasOwn(request.body, 'reasoning'), 'preserve configured provider reasoning default');
      assert.ok(!Object.hasOwn(request.body, 'reasoning_effort'));
      assert.ok(!Object.hasOwn(request.body, 'temperature'));
      assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
      assert.equal(request.body.tools[0].name, 'fixture_echo');
      if (!index) return json({ output });
      assert.deepEqual(request.body.input.slice(2, 4), output);
      assert.equal(request.body.input[4].type, 'function_call_output');
      assert.equal(request.body.input[4].call_id, 'call_1');
      return json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] });
    }, async requests => {
      assert.equal(await chatWithTools(configured(model), prompt, { tools, executeTool: async () => ({ ok: true }) }), 'OK');
      assert.equal(requests.length, 2);
    });
    await withFetch(request => {
      assert.equal(request.body.max_output_tokens, 240);
      assert.ok(!Object.hasOwn(request.body, 'max_completion_tokens'));
      assert.ok(!Object.hasOwn(request.body, 'max_tokens'));
      return json({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] });
    }, () => chatCloudTurn(configured(model), prompt, { tools, max_tokens: 240 }));
  }
  await withFetch(request => {
    assert.equal(request.url, 'https://compatible.invalid/v1/chat/completions');
    return message('OK');
  }, () => chatCloudTurn(configured('gpt-6-astra', 'https://compatible.invalid/v1'), prompt, { tools }));

  // Native Ollama object arguments, missing call ids, thinking and tool_name.
  await withFetch((request, index) => {
    assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(request.body.model, 'fake-ollama');
    assert.equal(request.body.stream, false);
    if (!index) return json({ message: { role: 'assistant', content: '', thinking: 'native transcript',
      tool_calls: [{ function: { name: 'fixture_echo', arguments: { text: 'hello' } } }] } });
    assert.deepEqual(request.body.messages[2].tool_calls[0].function.arguments, { text: 'hello' });
    assert.equal(request.body.messages[2].thinking, 'native transcript');
    assert.equal(request.body.messages[3].tool_name, 'fixture_echo');
    assert.equal(JSON.parse(request.body.messages[3].content).ok, true);
    return json({ message: { role: 'assistant', content: 'OK' } });
  }, async () => assert.equal(await chatWithTools({ ...configured(), provider: 'ollama' }, prompt,
    { tools, executeTool: async () => ({ ok: true }) }), 'OK'));

  // Malformed/unknown/duplicate calls never execute; tool failures reach the model.
  let safeExecutions = 0;
  await withFetch((request, index) => {
    if (index === 0) return invoking([call('broken', '{'), call('unknown', '{}', 'not_offered'), call('repeat')]);
    if (index === 1) {
      const outputs = request.body.messages.filter(item => item.role === 'tool').map(item => JSON.parse(item.content));
      assert.deepEqual(outputs.map(item => item.error.code), ['invalid_tool_arguments', 'unknown_tool', 'tool_execution_failed']);
      assert.ok(!JSON.stringify(outputs).includes(secret));
      return invoking([call('repeat')]);
    }
    assert.equal(JSON.parse(request.body.messages.at(-1).content).error.code, 'duplicate_tool_call');
    return message('I could not send it.');
  }, async () => {
    const raw = await chatWithTools(configured(), prompt, { tools, executeTool: async () => { safeExecutions++; throw Error(secret); } });
    assert.equal(raw, 'I could not send it.');
    assert.equal(safeExecutions, 1);
  });
  await withFetch((request, index) => {
    if (!index) return invoking();
    assert.equal(JSON.parse(request.body.messages.at(-1).content).error.code, 'tool_result_limit');
    return message('too large');
  }, () => chatWithTools(configured(), prompt, { tools, executeTool: async () => ({ payload: 'x'.repeat(70_000) }) }));

  const uncertain = { ok: false, error: { code: 'send_uncertain', message: 'No confirmation received' },
    result: { uncertain: true } };
  await withFetch((request, index) => {
    if (!index) return invoking();
    assert.deepEqual(JSON.parse(request.body.messages.at(-1).content), uncertain);
    return message('I cannot confirm it was sent.');
  }, () => chatWithTools(configured(), prompt, { tools, executeTool: async () => uncertain }));

  // Bound execution and final request; provider ignoring tool_choice fails clearly.
  let limitedCalls = 0;
  await withFetch((request, index) => {
    if (index === 2) assert.equal(request.body.tool_choice, 'none');
    return invoking([call(`call_${index}`)]);
  }, async requests => {
    await assert.rejects(() => chatWithTools(configured(), prompt, { tools, maxToolRounds: 2,
      executeTool: async () => { limitedCalls++; return { ok: true }; } }), { code: 'model_tool_loop_limit' });
    assert.equal(limitedCalls, 2);
    assert.equal(requests.length, 3);
  });

  // No fallback, retries, regex interpretation or provider-body leakage.
  for (const provider of ['cloud', 'ollama']) {
    const config = { ...configured(), provider };
    const turn = provider === 'cloud' ? chatCloudTurn : chatOllamaTurn;
    for (const handler of [() => json({ error: { message: secret } }, 400),
      () => { throw Error(secret); }, () => new Response(secret),
      () => json(provider === 'cloud' ? { choices: [{ message: { content: null } }] } : { message: { content: '' } })]) {
      await withFetch(handler, async requests => {
        await assert.rejects(() => turn(config, prompt, { tools }), error => !error.message.includes(secret));
        assert.equal(requests.length, 1);
      });
    }
    const aborting = request => new Promise((resolve, reject) => {
      request.options.signal.addEventListener('abort', () => reject(Error(secret)), { once: true });
    });
    await withFetch(aborting, async () => {
      const controller = new AbortController();
      const pending = turn(config, prompt, { tools, signal: controller.signal });
      controller.abort();
      await assert.rejects(() => pending, { name: 'AbortError', code: 'model_aborted' });
    });
    await withFetch(() => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    } })), async () => {
      const controller = new AbortController();
      const pending = turn(config, prompt, { tools, signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(() => pending, { name: 'AbortError', code: 'model_aborted' });
    });
    await withFetch(aborting, async () => {
      await assert.rejects(() => turn(config, prompt, { tools, timeoutMs: 10 }), error => /timeout/.test(error.code));
    });
  }
  // Truncation or obsolete/malformed protocols cannot authorize an effect.
  for (const [config, response] of [
    [configured(), { choices: [{ finish_reason: 'length', message: { tool_calls: [call()] } }] }],
    [configured(), { choices: [{ finish_reason: 'content_filter', message: { content: 'partial', tool_calls: [call()] } }] }],
    [configured(), { choices: [{ message: { content: 'partial', function_call: { name: 'fixture_echo', arguments: '{}' } } }] }],
    [configured(), { choices: [{ message: { content: { text: 'not a native text body' } } }] }],
    [configured(), { choices: [{ message: { content: '', tool_calls: Array.from({ length: 9 }, (_, index) => call(`extra_${index}`)) } }] }],
    [configured('gpt-6.1-terra'), { status: 'incomplete', output: [{ type: 'function_call', call_id: 'one', name: 'fixture_echo', arguments: '{}' }] }],
    [configured('gpt-6.1-terra'), { status: 'failed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }] }],
    [{ ...configured(), provider: 'ollama' }, { done: false, message: { content: 'partial', tool_calls: [{ function: { name: 'fixture_echo', arguments: {} } }] } }],
    [{ ...configured(), provider: 'ollama' }, { done_reason: 'length', message: { content: 'partial' } }],
  ]) {
    await withFetch(() => json(response), async requests => {
      let effects = 0;
      await assert.rejects(() => chatWithTools(config, prompt, { tools, executeTool: async () => { effects++; } }));
      assert.equal(effects, 0);
      assert.equal(requests.length, 1, 'invalid provider replies fail without endpoint/model fallback');
    });
  }
  await withFetch(() => { throw Error('must not reach provider'); }, async requests => {
    await assert.rejects(() => chatWithTools(configured(), prompt, { tools }), { code: 'model_tools_unavailable' });
    assert.equal(requests.length, 0);
  });
  // Cancel after an effect prevents any second provider request or further effects.
  await withFetch(() => invoking([call('one'), call('two')]), async requests => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(() => chatWithTools(configured(), prompt, { tools, signal: controller.signal,
      executeTool: async () => { calls++; controller.abort(); return { ok: true }; } }), { name: 'AbortError' });
    assert.equal(calls, 1);
    assert.equal(requests.length, 1);
  });
  console.log('model-tools: PASS (native Cloud/Responses/Ollama transcripts, same model, budgets, safe errors, cancellation, limits)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
