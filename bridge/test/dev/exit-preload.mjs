// Preloaded (node --import) into the real bin by walkie-dev.test.js: every fetch is answered the way a provider would, and
// a call of process.exit() is reported on stderr before it goes ahead.
const exit = process.exit;
process.exit = (code) => {
  console.error('process.exit() was called');
  return exit.call(process, code);
};

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url) => {
  if (String(url).endsWith('/audio/transcriptions')) return json({ text: '帮我跑一下测试' });
  if (String(url).endsWith('/audio/speech')) return new Response(new Uint8Array(48_000)); // one second of 24 kHz PCM16 silence
  return json({ choices: [{ message: { content: '{"intent":"to_claude","project":null,"text":"帮我跑一下测试"}' } }] });
};
