// A secret typed at the person's own terminal: no echo, never an argument, never a file. Only a real terminal will do, because piped
// input would put the password in somebody's shell history or script.
export function readSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('a password is typed at a terminal, and this is not one: run this command in your own terminal'));
      return;
    }
    output.write(question);
    const wasRaw = Boolean(input.isRaw);
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    let secret = [];
    let escape = false; // inside an escape sequence (an arrow key sends ESC [ A): its letters are not typing
    const finish = (settle) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      settle();
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (escape) {
          if (/[A-Za-z~]/.test(ch)) escape = false;
          continue;
        }
        if (ch === '\u001b') escape = true;
        else if (ch === '\r' || ch === '\n') return finish(() => resolve(secret.join('')));
        else if (ch === '\u0003') return finish(() => reject(new Error('cancelled')));
        else if (ch === '\u007f' || ch === '\b') secret.pop();
        else if (ch >= ' ') secret.push(ch);
      }
    };
    input.on('data', onData);
  });
}
