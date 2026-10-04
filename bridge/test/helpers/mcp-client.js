// Test helper: talking to the permission server the way Claude Code does, over HTTP on 127.0.0.1.
// `rawRequest` is a plain http request, because fetch will not let a test set Host or hang up half way.
// `mcpClient` is the small part of an MCP client that walkie answers.
import http from 'node:http';

export function rawRequest({ port, method = 'POST', path = '/mcp', headers = {}, body, agent, signal }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const lengthHeader = data === null ? {} : { 'content-length': Buffer.byteLength(data) };
    const req = http.request({ host: '127.0.0.1', port, method, path, agent, signal, headers: { ...lengthHeader, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(data);
  });
}

export function mcpClient({ url, token, agent }) {
  const { port } = new URL(url);
  let id = 0;
  const headersFor = (extra) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...extra });
  const post = (body, extra = {}, signal) => rawRequest({ port, headers: headersFor(extra), body, agent, signal });
  const rpc = async (method, params, signal) => (await post({ jsonrpc: '2.0', id: ++id, method, params }, {}, signal)).json();
  return {
    port,
    post,
    rpc,
    notify: (method, params) => post({ jsonrpc: '2.0', method, params }),
    initialize: () => rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
    // Asks the permission tool and returns the verdict it answered, as an object.
    async approve(args, signal) {
      const reply = await rpc('tools/call', { name: 'approve', arguments: args }, signal);
      return JSON.parse(reply.result.content[0].text);
    },
  };
}
