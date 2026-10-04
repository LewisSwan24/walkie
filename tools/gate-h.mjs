// Gate H, on the real S3: the screens and the keys of plan 4, without anyone touching the device and without any API. One link, a list
// of scenes; each puts a screen on the S3 as the bridge would, presses keys with TEST KEYS, and checks what comes back (the
// buttons, the approval verdicts, the take's frames, the S3's own LOG lines) or what the display shows (TEST SNAP).
// Usage: node tools/gate-h.mjs [--port COMx] [--only "scene name;scene name"]
// Exit code 0 when every scene held, 1 when one did not. walkie must be running on the S3 (node tools/flash.mjs). The last scene
// opens the firmware switch and closes it again; if it is interrupted with the screen open, a tap on the front key reboots the S3
// into on-the-beat (node tools/boot.mjs app1 brings walkie back).
import { FLAG, TYPE } from '../bridge/src/link/frame.js';
import { BUTTON, KEY, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, testKeysPayload, uiPayload } from '../bridge/src/link/messages.js';
import { connect } from '../bridge/src/dev/connect.js';
import { takeSnap } from '../bridge/src/dev/snap.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = flag('--only')?.split(';');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BUTTON_NAMES = Object.fromEntries(Object.entries(BUTTON).map(([name, code]) => [code, name]));
const { FRONT, SIDE } = KEY;

const link = await connect({ port: flag('--port') });
let seen;
const reset = () => (seen = { logs: [], buttons: [], verdicts: [], takeFrames: 0, takeEnds: [] });
reset();
link.on('log', (line) => seen.logs.push(line));
link.on('audio-up', (f) => {
  seen.takeFrames++;
  if (f.flags & FLAG.EOS) seen.takeEnds.push(f.flags & FLAG.REASON ? 'EOS+REASON' : 'EOS');
});
link.on('frame', (f) => {
  if (f.type === TYPE.BUTTON) seen.buttons.push(BUTTON_NAMES[parseButton(f.payload)?.event]);
  if (f.type === TYPE.APPROVAL_RES) {
    const r = parseApprovalRes(f.payload);
    seen.verdicts.push(`#${r.id} ${r.allow ? 'allow' : 'deny'}${r.reasonFollows ? '+reason' : ''}`);
  }
});

const ui = (view) => link.send(TYPE.UI, uiPayload(view));
const approval = (tool, preview) => link.send(TYPE.APPROVAL_REQ, approvalReqPayload({ id: 1, tool, preview }));
const keys = (steps) => link.send(TYPE.TEST, testKeysPayload(steps));
const tap = (mask, holdMs) => keys([{ delayMs: 0, mask }, { delayMs: holdMs, mask: 0 }]);
const screens = () => seen.logs.filter((l) => l.startsWith('screen ')).map((l) => l.slice(7));
const waitFor = async (check, ms) => {
  for (let waited = 0; !check() && waited < ms; waited += 50) await sleep(50);
  return check();
};

// The colour of a pixel in the header bar, where there is no text: x 130, y 2.
async function headerColour() {
  const { width, rgb } = await takeSnap(link);
  const at = (2 * width + 130) * 3;
  return [rgb[at], rgb[at + 1], rgb[at + 2]];
}
const near = ([r, g, b], [wr, wg, wb]) => Math.abs(r - wr) < 24 && Math.abs(g - wg) < 24 && Math.abs(b - wb) < 24;

const REPLY_16_LINES = Array.from({ length: 16 }, (_, i) => `第${i + 1}行：这一行有二十个汉字左右用来占满一行的宽度`).join('\n');

// Each scene returns what it found wanting, as a list of sentences; an empty list is a pass.
const scenes = {
  'confirm: the side key cancels': async () => {
    ui({ state: UI_STATE.CONFIRM, project: 'walkie', text: '取消键' });
    await sleep(500);
    tap(SIDE, 150);
    await waitFor(() => seen.buttons.length > 0, 1500);
    return seen.buttons.join() === 'CANCEL' ? [] : [`buttons ${seen.buttons.join() || 'none'}, wanted CANCEL`];
  },
  'working: the side key held for a second stops, a tap does not': async () => {
    ui({ state: UI_STATE.WORKING, project: 'walkie', elapsedMs: 83_000 });
    await sleep(500);
    tap(SIDE, 150);
    await sleep(700);
    const afterTap = seen.buttons.join();
    tap(SIDE, 1300);
    await waitFor(() => seen.buttons.length > 0, 2500);
    return [...(afterTap ? [`a tap sent ${afterTap}`] : []), ...(seen.buttons.join() === 'STOP' ? [] : [`the hold sent ${seen.buttons.join() || 'nothing'}, wanted STOP`])];
  },
  'reply: five pages, the side key turns four and the last one dismisses': async () => {
    ui({ state: UI_STATE.REPLY, project: 'walkie', text: REPLY_16_LINES });
    await sleep(600);
    const bad = [];
    for (let page = 1; page <= 5; page++) {
      tap(SIDE, 150);
      await sleep(600);
      const dismissed = seen.buttons.length > 0;
      if (page < 5 && dismissed) bad.push(`page ${page} dismissed the reply`);
      if (page === 5 && seen.buttons.join() !== 'DISMISS') bad.push(`page 5 sent ${seen.buttons.join() || 'nothing'}, wanted DISMISS`);
    }
    return bad;
  },
  'error: the side key dismisses': async () => {
    ui({ state: UI_STATE.ERROR, text: '没听清，再说一次' });
    await sleep(500);
    tap(SIDE, 150);
    await waitFor(() => seen.buttons.length > 0, 1500);
    return seen.buttons.join() === 'DISMISS' ? [] : [`buttons ${seen.buttons.join() || 'none'}, wanted DISMISS`];
  },
  'approval: the front key allows': async () => {
    approval('Bash', 'npm test');
    await sleep(600);
    tap(FRONT, 150);
    await waitFor(() => seen.verdicts.length > 0, 1500);
    return seen.verdicts.join() === '#1 allow' ? [] : [`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 allow`];
  },
  'approval: the side key denies': async () => {
    approval('Bash', 'rm -rf build');
    await sleep(600);
    tap(SIDE, 150);
    await waitFor(() => seen.verdicts.length > 0, 1500);
    return seen.verdicts.join() === '#1 deny' ? [] : [`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 deny`];
  },
  'approval: the front key held records a reason, which ends the take with the REASON flag': async () => {
    approval('Bash', 'git push --force');
    await sleep(600);
    tap(FRONT, 1500);
    await waitFor(() => seen.verdicts.length > 0 && seen.takeEnds.length > 0, 4000);
    const bad = [];
    if (seen.verdicts.join() !== '#1 deny+reason') bad.push(`verdicts ${seen.verdicts.join() || 'none'}, wanted #1 deny+reason`);
    if (seen.takeEnds.join() !== 'EOS+REASON') bad.push(`the take ended ${seen.takeEnds.join() || 'never'}, wanted EOS+REASON`);
    if (seen.takeFrames < 40) bad.push(`only ${seen.takeFrames} take frames for a 1.5 s hold`);
    return bad;
  },
  'talking while working: the take ends with EOS and the working screen is back': async () => {
    ui({ state: UI_STATE.WORKING, project: 'walkie', elapsedMs: 5000 });
    await sleep(500);
    tap(FRONT, 1200);
    await waitFor(() => seen.takeEnds.length > 0, 3000);
    await sleep(300);
    const bad = [];
    if (seen.takeEnds.join() !== 'EOS') bad.push(`the take ended ${seen.takeEnds.join() || 'never'}, wanted EOS`);
    if (screens().at(-1) !== 'working') bad.push(`the screen after the take was ${screens().at(-1)}`);
    return bad;
  },
  'a tap on the front key is not a take': async () => {
    ui({ state: UI_STATE.IDLE, project: 'walkie' });
    await sleep(500);
    tap(FRONT, 150);
    await sleep(900);
    return seen.takeFrames === 0 ? [] : [`${seen.takeFrames} take frames from a tap`];
  },
  'the header colours are the ones the screens ask for (red and blue are not swapped)': async () => {
    const bad = [];
    const want = [
      [UI_STATE.ERROR, '出错了', [197, 0, 0], 'error red'],
      [UI_STATE.CONFIRM, '确认', [255, 125, 0], 'confirm amber'],
      [UI_STATE.WORKING, '', [0, 0, 132], 'working navy'],
    ];
    for (const [state, text, colour, name] of want) {
      ui({ state, project: 'walkie', text: text ? '颜色' : undefined });
      await sleep(900);
      const got = await headerColour();
      if (!near(got, colour)) bad.push(`${name}: the header is ${got.join(',')}, wanted about ${colour.join(',')}`);
    }
    return bad;
  },
  // Last, because a screen left open here turns the next front tap into a reboot of the S3 into app0 (it is the confirm key).
  'chord: both keys held 3 s open the firmware switch and the side key closes it': async () => {
    ui({ state: UI_STATE.IDLE, project: 'walkie' });
    await sleep(500);
    keys([{ delayMs: 0, mask: FRONT | SIDE }, { delayMs: 3300, mask: 0 }]);
    await waitFor(() => screens().includes('switch-confirm'), 5000);
    await sleep(600); // until both keys are up: a key press while they are down is part of the chord and means nothing
    tap(SIDE, 150);
    if (!(await waitFor(() => screens().at(-1) === 'idle', 2000))) {
      await sleep(10_500); // the switch screen closes itself after 10 s
      return [`the side key did not close the switch screen (screens ${screens().join()})`];
    }
    return screens().join() === 'idle,switch-confirm,idle' || screens().join() === 'switch-confirm,idle' ? [] : [`screens ${screens().join()}`];
  },
};

let failed = 0;
try {
  await sleep(300);
  for (const [name, run] of Object.entries(scenes)) {
    if (only && !only.includes(name)) continue;
    reset();
    let bad;
    try {
      bad = await run();
    } catch (err) {
      bad = [`threw: ${err.message}`];
    }
    if (bad.length === 0) console.log(`PASS ${name}`);
    else {
      failed++;
      console.log(`FAIL ${name}: ${bad.join('; ')}`);
      console.log(`     the S3 said: ${seen.logs.filter((l) => !l.startsWith('key script')).join(' | ')}`);
    }
  }
} finally {
  link.close();
}
console.log(failed === 0 ? 'gate H: every scene held' : `gate H: ${failed} scene(s) did not hold`);
process.exitCode = failed === 0 ? 0 : 1;
