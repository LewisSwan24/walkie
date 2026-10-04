// A fetch that answers from a script and remembers what it was asked, for the provider tests.

// handler(url, init, n) returns a Response, or throws. calls collects {url, init}.
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.signal?.aborted) throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

export const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// A streaming body that hands out `chunks` one by one; `then` decides what happens after the last one:
// 'end' closes the stream, 'hang' leaves it open and silent, an Error breaks it.
export function streamResponse(chunks, then = 'end', status = 200) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) return void controller.enqueue(new Uint8Array(chunks[i++]));
      if (then === 'end') return controller.close();
      if (then instanceof Error) return controller.error(then);
      return new Promise(() => {});
    },
  });
  return new Response(body, { status });
}
