// What the bridge prints: one timestamped line per event, and every reply in full (spec 4, step 6; the device shows only a few
// lines of it).
const pad = (n) => String(n).padStart(2, '0');
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const indent = (text, by = '  ') => text.split('\n').map((line) => `${by}${line}`);

// `out(line)` writes one line; `now()` is the clock. Nothing here knows about the screen or the speaker.
export function createConsole({ out = (line) => console.log(line), now = () => new Date() } = {}) {
  const log = (line) => {
    const t = now();
    out(`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())} ${line}`);
  };

  // What Claude answered: kind 'reply' or 'compact' (the manager's `reply` event).
  function reply(r) {
    const cost = `${seconds(r.ms)}, $${r.costUsd.toFixed(3)}`;
    if (r.kind === 'compact') {
      log(`[compact] ${r.project}, ${cost}`);
      for (const line of indent(r.screen)) out(line);
      return;
    }
    log(`[reply] ${r.project} turn ${r.turns}, ${cost}${r.tagged ? '' : ', no <voice> tag'}`);
    out(`  voice: ${r.voice}`);
    for (const line of indent(r.text || r.screen)) out(line);
  }

  // What the speech chain made of a take (the turn's 'heard' event): the words and where they go, or why there were none.
  function heard(h) {
    if (h.status !== 'ok') return log(`[heard] nothing clear (${h.reason})`);
    const goes = h.intent ? ` → ${h.intent}${h.project ? ` ${h.project}` : ''}` : '';
    log(`[heard] 「${h.transcript}」${goes}${h.transcribedBy ? ` (${h.transcribedBy})` : ''}`);
  }

  // Prints what the manager, the approvals queue and the link say. `manager` and `approvals` have `on(name, fn)`; `link` is an
  // EventEmitter.
  function attach({ manager, approvals, link }) {
    manager.on('working', (w) => log(`[working] ${w.tool ? `${w.tool}${w.summary ? `: ${w.summary}` : ''}` : 'thinking'}`));
    manager.on('reply', reply);
    manager.on('notice', (n) => log(`[notice] ${n.kind}: ${n.text}`));
    manager.on('failure', (f) => log(`[failure] ${f.kind}: ${f.message}`));
    manager.on('project', (p) => log(`[project] ${p.name}`));
    approvals.on('show', (r) => {
      log(`[approval] #${r.id} ${r.tool}`);
      for (const line of indent(r.preview, '    ')) out(line);
    });
    approvals.on('clear', (c) => log(`[approval] #${c.id} ${c.outcome}`));
    link.on('status', (s) => log(`[link] ${s}`));
    link.on('hello', (h) => log(`[link] walkie ${h.version} is connected (ring ${h.ringBytes} bytes)`));
    link.on('log', (s) => log(`[S3] ${s}`));
    link.on('down', (reason) => log(`[link] down: ${reason}`));
  }

  return { log, reply, heard, attach };
}
