import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { APPROVE_TOOL, createPermServer, DENIED, PROTOCOLS, SERVER_NAME } from '../../src/perm/server.js';
import { mcpClient, rawRequest } from '../helpers/mcp-client.js';

const ALLOW = async () => ({ behavior: 'allow' });

// A server on a free port whose answers come from `decide`, with what it logged and a client that knows its token.
async function serve(t, decide = ALLOW, options = {}) {
  const logs = [];
  const server = createPermServer({ decide, log: (line) => logs.push(line), ...options });
  const { url, token } = await server.start();
  t.after(() => server.close());
  return { server, url, token, logs, port: new URL(url).port, client: mcpClient({ url, token }) };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const until = async (ok, what) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ok(), what);
};

test('start gives the URL for --mcp-config, on 127.0.0.1, and a token no other server shares', async (t) => {
  const a = await serve(t);
  const b = await serve(t);
  assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.port, b.port);
  assert.equal(a.server.token, a.token);
});

test('the handshake of the real client: initialize, the initialized notification, tools/list', async (t) => {
  const { client } = await serve(t);
  const init = await client.initialize();
  assert.deepEqual(init, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'walkie', version: '0.1.0' } } });
  const note = await client.notify('notifications/initialized');
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  const list = await client.rpc('tools/list');
  assert.deepEqual(list.result, { tools: [APPROVE_TOOL] });
  assert.deepEqual(APPROVE_TOOL.inputSchema.required, ['tool_name', 'input']);
  assert.equal(SERVER_NAME, 'walkie');
  assert.deepEqual((await client.rpc('ping')).result, {});
});

test('it answers with the protocol version the client asks for if it knows it, and its newest if not', async (t) => {
  const { client } = await serve(t);
  for (const version of PROTOCOLS) assert.equal((await client.rpc('initialize', { protocolVersion: version })).result.protocolVersion, version);
  for (const odd of ['2099-01-01', '', 7, null, undefined]) assert.equal((await client.rpc('initialize', { protocolVersion: odd })).result.protocolVersion, PROTOCOLS[0], String(odd));
  assert.equal((await client.rpc('initialize')).result.protocolVersion, PROTOCOLS[0]);
});

test('the discovery call the real client makes first gets the plain answer for a method that does not exist', async (t) => {
  const { client } = await serve(t);
  const res = await client.post({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'method not found: server/discover' } });
});

test('an allowed call is answered with the input it was given, and decide is told what was asked', async (t) => {
  const asked = [];
  const { client } = await serve(t, async (request) => (asked.push(request), { behavior: 'allow' }));
  const input = { file_path: 'C:\\proj\\note.txt', content: '你好 walkie' };
  assert.deepEqual(await client.approve({ tool_name: 'Write', input, tool_use_id: 'toolu_01' }), { behavior: 'allow', updatedInput: input });
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0], signal: undefined }, { tool: 'Write', input, toolUseId: 'toolu_01', signal: undefined });
  assert.ok(asked[0].signal instanceof AbortSignal);
  assert.equal(asked[0].signal.aborted, false);
});

test('a denied call carries the message, and any answer that is not a clear allow is a denial', async (t) => {
  let verdict;
  const { client } = await serve(t, async () => verdict);
  const ask = () => client.approve({ tool_name: 'Bash', input: { command: 'rm -rf /' } });
  verdict = { behavior: 'deny', message: '手腕上没人回应，先别做。' };
  assert.deepEqual(await ask(), { behavior: 'deny', message: '手腕上没人回应，先别做。' });
  for (const odd of [{ behavior: 'deny' }, { behavior: 'deny', message: '' }, { behavior: 'maybe' }, { behavior: 'ALLOW' }, {}, undefined, null, 'allow', true]) {
    verdict = odd;
    assert.deepEqual(await ask(), { behavior: 'deny', message: DENIED }, JSON.stringify(odd));
  }
  assert.equal(DENIED, '用户没有允许这个操作。');
});

test('when decide throws, the answer is a denial that says so, and it is logged', async (t) => {
  const { client, logs } = await serve(t, async () => {
    throw new Error('the device is gone');
  });
  assert.deepEqual(await client.approve({ tool_name: 'Write', input: {} }), { behavior: 'deny', message: 'walkie 没能问你：the device is gone' });
  assert.deepEqual(logs, ['perm: could not ask about Write: the device is gone', 'perm: Write denied']);
});

test('the log has the tool and the outcome and never what the tool was given', async (t) => {
  const { client, logs } = await serve(t, async ({ tool }) => (tool === 'Write' ? { behavior: 'allow' } : { behavior: 'deny', message: 'no' }));
  await client.approve({ tool_name: 'Write', input: { content: 'SECRET-CONTENT' } });
  await client.approve({ tool_name: 'Bash', input: { command: 'echo SECRET-COMMAND' } });
  assert.deepEqual(logs, ['perm: Write allowed', 'perm: Bash denied']);
});

test('a call that is not well formed is an error of the protocol, not a question for the device', async (t) => {
  let asked = 0;
  const { client } = await serve(t, async () => (asked++, { behavior: 'allow' }));
  const call = (args, name = 'approve') => client.rpc('tools/call', { name, arguments: args });
  for (const args of [undefined, null, {}, { tool_name: '' }, { tool_name: 5 }, { tool_name: 'Write', input: [] }, { tool_name: 'Write', input: null }, { tool_name: 'Write', input: 'x' }]) {
    const reply = await call(args);
    assert.equal(reply.error?.code, -32602, JSON.stringify(args));
  }
  assert.match((await call({ tool_name: 'Write', input: {} }, 'other')).error.message, /unknown tool other/);
  assert.equal((await client.rpc('tools/call')).error.code, -32602);
  assert.equal((await client.rpc('resources/list')).error.code, -32601);
  assert.equal(asked, 0);
});

test('an input that is left out is an empty one, and a tool use id that is not text is none', async (t) => {
  const asked = [];
  const { client } = await serve(t, async (request) => (asked.push(request), { behavior: 'allow' }));
  assert.deepEqual(await client.approve({ tool_name: 'Glob' }), { behavior: 'allow', updatedInput: {} });
  await client.approve({ tool_name: 'Glob', input: {}, tool_use_id: 7 });
  await client.approve({ tool_name: 'Glob', input: {}, tool_use_id: 'toolu_9' });
  assert.deepEqual(asked.map((a) => a.toolUseId), [null, null, 'toolu_9']);
});

test('a request without the token, or with the wrong one, is refused before anything is read', async (t) => {
  const { token, port } = await serve(t);
  const send = (authorization) => rawRequest({ port, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  for (const authorization of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${token}x`, `Bearer ${token.slice(1)}`, `Bearer ${'0'.repeat(64)}`, `Basic ${token}`, `Basic  ${token}`, token]) {
    const res = await send(authorization);
    assert.equal(res.status, 401, String(authorization));
    assert.equal(res.headers['www-authenticate'], 'Bearer');
    assert.equal(res.headers.connection, 'close');
  }
  assert.equal((await send(`Bearer ${token}`)).status, 200);
});

test('a request that names another host is refused even with the right token, and localhost is a name for this one', async (t) => {
  const { token, port } = await serve(t);
  const send = (host) => rawRequest({ port, headers: { host, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, '127.0.0.1', 'localhost', `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`]) {
    assert.equal((await send(host)).status, 403, host);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) assert.equal((await send(host)).status, 200, host);
});

test('a request with an Origin header, which only a browser sends, is refused', async (t) => {
  const { client } = await serve(t);
  const res = await client.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.connection, 'close');
});

test('only POST to /mcp with a JSON body is served, and the refusals close the connection', async (t) => {
  const { token, port } = await serve(t);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const check = async (options, status) => {
    const res = await rawRequest({ port, headers, body, ...options });
    assert.equal(res.status, status, JSON.stringify(options));
    if (status >= 400) assert.equal(res.headers.connection, 'close');
    return res;
  };
  for (const path of ['/', '/other', '/mcp/', '/mcpx', '/%6dcp']) await check({ path }, 404);
  await check({ path: '/mcp?session=1' }, 200);
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await check({ method }, 405)).headers.allow, 'POST');
  await check({ headers: { authorization: headers.authorization, 'content-type': 'text/plain' } }, 415);
  await check({ headers: { authorization: headers.authorization } }, 415);
  await check({ headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } }, 200);
  await check({ headers: { ...headers, 'content-type': 'APPLICATION/JSON' } }, 200);
  await check({ headers: { ...headers, 'content-type': 'application/jsonx' } }, 415);
  await check({ headers: { ...headers, 'content-type': 'text/application/json' } }, 415);
});

test('a body that is not JSON is a parse error, and a JSON value that is not a message is an invalid request', async (t) => {
  const { client } = await serve(t);
  const bad = await client.post('{"jsonrpc": "2.0", "id": 1, "method": ');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json(), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  for (const text of ['5', 'null', '"x"', 'true', '{}', '{"jsonrpc":"1.0","id":1,"method":"ping"}']) {
    const res = await client.post(text);
    assert.equal(res.status, 200, text);
    assert.equal(res.json().error.code, -32600, text);
  }
});

test('a batch is answered with an array, in order, without an answer for a notification', async (t) => {
  const { client } = await serve(t);
  const res = await client.post([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().map((r) => r.id), [1, 'b']);
  const notes = await client.post([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }]);
  assert.equal(notes.status, 202);
  assert.equal((await client.post({ jsonrpc: '2.0', id: 3, result: {} })).status, 202, 'a reply to a request we never made is ignored');
});

test('a body over the limit is refused with 413 and the next request still works', async (t) => {
  const { client, token, port } = await serve(t, ALLOW, { maxBody: 1000 });
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2000) } });
  const res = await rawRequest({ port, agent, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: big });
  assert.equal(res.status, 413);
  assert.equal(res.json().error.code, -32600);
  assert.equal((await client.rpc('ping')).result !== undefined, true);
  const small = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'y'.repeat(300) } });
  assert.equal((await rawRequest({ port, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: small })).status, 200);
});

test('a body of exactly the limit is served and one byte more is not', async (t) => {
  const { token, port } = await serve(t, ALLOW, { maxBody: 1000 });
  const bodyOf = (bytes) => {
    const empty = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: '' } });
    return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(bytes - Buffer.byteLength(empty)) } });
  };
  const send = (body) => rawRequest({ port, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body });
  assert.equal(Buffer.byteLength(bodyOf(1000)), 1000);
  assert.equal((await send(bodyOf(1000))).status, 200);
  assert.equal((await send(bodyOf(1001))).status, 413);
});

test('a big Write gets through whole', async (t) => {
  const seen = [];
  const { client } = await serve(t, async ({ input }) => (seen.push(input.content.length), { behavior: 'allow' }));
  const content = 'a'.repeat(3 * 1024 * 1024);
  const verdict = await client.approve({ tool_name: 'Write', input: { file_path: 'big.txt', content } });
  assert.equal(seen[0], content.length);
  assert.equal(verdict.updatedInput.content.length, content.length);
});

test('requests wait for their answers independently, so two tools asked at once are answered each in its own time', async (t) => {
  const waiting = new Map();
  const { client } = await serve(t, ({ tool }) => new Promise((resolve) => waiting.set(tool, resolve)));
  const first = client.approve({ tool_name: 'Write', input: {} });
  const second = client.approve({ tool_name: 'Bash', input: {} });
  await until(() => waiting.size === 2, 'both requests reached decide');
  waiting.get('Bash')({ behavior: 'deny', message: 'second first' });
  assert.deepEqual(await second, { behavior: 'deny', message: 'second first' });
  waiting.get('Write')({ behavior: 'allow' });
  assert.equal((await first).behavior, 'allow');
});

test('the server knows how many requests wait for an answer: while they wait, and no more once they are answered, refused or abandoned', async (t) => {
  const waiting = new Map();
  const { server, client } = await serve(t, ({ tool }) => new Promise((resolve) => waiting.set(tool, resolve)));
  assert.equal(server.waiting(), 0);
  const first = client.approve({ tool_name: 'Write', input: {} });
  const hangUp = new AbortController();
  const second = client.approve({ tool_name: 'Bash', input: {} }, hangUp.signal);
  second.catch(() => {});
  await until(() => waiting.size === 2, 'both requests reached decide');
  assert.equal(server.waiting(), 2);
  waiting.get('Write')({ behavior: 'allow' });
  await first;
  assert.equal(server.waiting(), 1);
  hangUp.abort();
  await until(() => server.waiting() === 0, 'the abandoned request is no longer counted');
  assert.equal((await client.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'x' })).status, 403);
  assert.equal(server.waiting(), 0);
  await client.rpc('ping');
  assert.equal(server.waiting(), 0);
});

test('when the client hangs up before an answer, the signal given to decide aborts and nothing is answered or logged', async (t) => {
  let signal = null;
  const { client, logs } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise(() => {});
  });
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await until(() => signal !== null, 'decide was asked');
  assert.equal(signal.aborted, false);
  hangUp.abort();
  await assert.rejects(pending);
  await until(() => signal.aborted, 'the signal aborted');
  await settle();
  assert.deepEqual(logs, []);
});

test('a decide that throws because the client left is not logged as a failure', async (t) => {
  const { client, logs } = await serve(t, ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await new Promise((resolve) => setTimeout(resolve, 30));
  hangUp.abort();
  await assert.rejects(pending);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(logs, []);
});

test('a decide that answers when the client has left, as the approvals queue does, is not logged as an answer', async (t) => {
  let signal = null;
  const { client, logs } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise((resolve) => s.addEventListener('abort', () => resolve({ behavior: 'deny', message: 'gone' })));
  });
  const hangUp = new AbortController();
  const pending = client.approve({ tool_name: 'Write', input: {} }, hangUp.signal);
  await until(() => signal !== null, 'decide was asked');
  hangUp.abort();
  await assert.rejects(pending);
  await until(() => signal.aborted, 'the signal aborted');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(logs, []);
});

test('a refusal that leaves a body unread does not break the connection the client keeps open', async (t) => {
  const { token, port, client } = await serve(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const refused = await rawRequest({ port, agent, method: 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal(refused.status, 405);
  const next = await rawRequest({ port, agent, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 2, method: 'ping' } });
  assert.equal(next.status, 200);
  assert.equal((await client.rpc('ping')).result !== undefined, true);
});

test('closing the server aborts the requests still waiting and ends the listening', async (t) => {
  let signal = null;
  const { server, client, port } = await serve(t, ({ signal: s }) => {
    signal = s;
    return new Promise(() => {});
  });
  const pending = client.approve({ tool_name: 'Write', input: {} });
  pending.catch(() => {});
  await until(() => signal !== null, 'decide was asked');
  await server.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(pending);
  await assert.rejects(rawRequest({ port, body: {} }), /ECONNREFUSED/);
  await server.close();
});

test('closing a server that was never started is fine, and a port that is taken is an error from start', async (t) => {
  await createPermServer({ decide: ALLOW }).close();
  const { port } = await serve(t);
  const second = createPermServer({ decide: ALLOW, port: Number(port) });
  await assert.rejects(second.start(), (err) => err.code === 'EADDRINUSE');
});

test('a fixed token can be given, and a request is only as good as that token', async (t) => {
  const { client, token } = await serve(t, ALLOW, { token: 'fixed-token-for-this-test' });
  assert.equal(token, 'fixed-token-for-this-test');
  assert.equal((await client.initialize()).result.serverInfo.name, 'walkie');
});
