// The permission endpoint Claude Code calls through `--permission-prompt-tool mcp__walkie__approve`: a small MCP server over
// Streamable HTTP on 127.0.0.1 (spec 6.3, 6.4). It answers with plain JSON, offers one tool, and knows nothing about the
// device: `decide` is handed every request and says what to answer. Anything Claude Code sends that is not on the short
// list below is refused. Written to what the real client does (claude 2.1.285, recorded 1 Oct 2026): it asks `server/discover`
// first and takes the -32601, then `initialize`, `notifications/initialized` (answered 202), a GET (405 is fine), `tools/list`.
//
// Anyone on this PC can reach a port on 127.0.0.1, and what answers here decides whether a tool runs. So a request needs the
// bearer token made for this run, a Host that names this server (a web page can be made to reach 127.0.0.1 under another
// name), and no Origin header (a web page always sends one; an MCP client never does).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

export const SERVER_NAME = 'walkie';
export const TOOL_NAME = 'approve';
export const DENIED = '用户没有允许这个操作。';
export const MAX_BODY = 32 * 1024 * 1024; // a Write of a big file arrives whole

export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first; the client's own pick is echoed when listed

export const APPROVE_TOOL = {
  name: TOOL_NAME,
  description: 'Asks the person wearing the walkie device whether Claude may run a tool.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function sameToken(given, token) {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Past the limit the rest of the body is thrown away as it arrives rather than the socket being cut, so that the refusal can
// still be sent; it closes the connection (see `send`).
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk) => {
      if (refused) return;
      size += chunk.length;
      if (size > maxBody) {
        refused = true;
        chunks.length = 0;
        reject(new RpcError(-32600, 'request too large'));
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// decide({tool, input, toolUseId, signal}) resolves {behavior: 'allow'} or {behavior: 'deny', message}. `signal` aborts when
// Claude Code drops the connection before an answer. An answer that cannot be given is a deny: this fails closed.
// `log(text)` hears what was asked about (the tool's name, never its input) and what was answered.
export function createPermServer({ decide, token = randomBytes(32).toString('hex'), host = '127.0.0.1', port = 0, maxBody = MAX_BODY, log = () => {} }) {
  let server = null;
  let hostPort = '';
  const waiting = new Set(); // the abort controllers of the requests that have been read and not yet answered

  async function approve(args, signal) {
    const { tool_name: tool, input = {}, tool_use_id: toolUseId = null } = args ?? {};
    if (typeof tool !== 'string' || !tool) throw new RpcError(-32602, 'tool_name must be a non-empty string');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RpcError(-32602, 'input must be an object');
    let verdict;
    try {
      verdict = await decide({ tool, input, toolUseId: typeof toolUseId === 'string' ? toolUseId : null, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      log(`perm: could not ask about ${tool}: ${err.message}`);
      verdict = { behavior: 'deny', message: `walkie 没能问你：${err.message}` };
    }
    const allowed = verdict?.behavior === 'allow';
    if (!signal.aborted) log(`perm: ${tool} ${allowed ? 'allowed' : 'denied'}`);
    const body = allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict?.message || DENIED };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  async function answer(message, signal) {
    if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return rpcError(message?.id, -32600, 'not a JSON-RPC 2.0 message');
    const { id, method, params } = message;
    if (typeof method !== 'string') return null; // a response to us, which we never ask for
    if (id === undefined) return null; // a notification: nothing to say
    try {
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          return rpcResult(id, {
            protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: '0.1.0' },
          });
        }
        case 'ping':
          return rpcResult(id, {});
        case 'tools/list':
          return rpcResult(id, { tools: [APPROVE_TOOL] });
        case 'tools/call':
          if (params?.name !== TOOL_NAME) throw new RpcError(-32602, `unknown tool ${params?.name}`);
          return rpcResult(id, await approve(params.arguments, signal));
        default:
          throw new RpcError(-32601, `method not found: ${method}`);
      }
    } catch (err) {
      if (signal.aborted) return null;
      return rpcError(id, err instanceof RpcError ? err.code : -32603, err.message);
    }
  }

  // A refusal may leave the request body unread on a socket the client means to reuse; closing the connection is the safe end.
  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'object' ? 'application/json' : 'text/plain; charset=utf-8',
      ...(status >= 400 ? { connection: 'close' } : {}),
      ...headers,
    });
    res.end(text);
  }

  async function onRequest(req, res) {
    try {
      const asked = req.headers.host ?? '';
      if (![`127.0.0.1:${hostPort}`, `localhost:${hostPort}`, `[::1]:${hostPort}`].includes(asked)) return send(res, 403, 'wrong host');
      if (req.headers.origin) return send(res, 403, 'no browsers'); // an MCP client sends no Origin; a web page would
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return send(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      if (new URL(req.url, 'http://walkie').pathname !== '/mcp') return send(res, 404, 'not found');
      if (req.method !== 'POST') return send(res, 405, 'POST only', { allow: 'POST' });
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, 'send application/json');
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req, maxBody));
      } catch (err) {
        return send(res, err instanceof RpcError ? 413 : 400, rpcError(null, err instanceof RpcError ? err.code : -32700, err instanceof RpcError ? err.message : 'parse error'));
      }
      const gone = new AbortController();
      waiting.add(gone);
      res.on('close', () => {
        waiting.delete(gone);
        if (!res.writableFinished) gone.abort();
      });
      const batch = Array.isArray(parsed);
      const replies = (await Promise.all((batch ? parsed : [parsed]).map((m) => answer(m, gone.signal)))).filter(Boolean);
      if (gone.signal.aborted) return;
      if (!replies.length) return send(res, 202);
      send(res, 200, batch ? replies : replies[0]);
    } catch (err) {
      log(`perm: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'internal error');
    }
  }

  return {
    token,
    // How many requests have been read and not yet answered.
    waiting: () => waiting.size,
    // Starts listening; resolves with the URL to put in --mcp-config.
    start() {
      return new Promise((resolve, reject) => {
        server = createServer(onRequest);
        server.once('error', reject);
        server.listen(port, host, () => {
          hostPort = String(server.address().port);
          resolve({ url: `http://127.0.0.1:${hostPort}/mcp`, token });
        });
      });
    },
    // Stops listening, aborts the signal of each request still waiting for an answer (before this resolves) and drops every connection.
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        for (const gone of [...waiting]) gone.abort();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
