// The device's screen as the bridge sees it (spec 6.3): which of the six UI states is showing, and the approval over it. It sends
// UI and APPROVAL_REQ frames and turns the device's BUTTON and APPROVAL_RES frames into events:
//
//   'cancel' 'stop' 'dismiss' 'switching'          a key press that the bridge acts on (BUTTON)
//   'verdict' {id, allow, reasonFollows}           his answer to the approval on the screen (APPROVAL_RES)
//
// The device takes any UI frame as the end of an approval, so while one is on the screen a screen change is kept back and sent
// when the approval is over. When the device (re)connects, the current screen is sent again: it knows nothing of what came before.
import { EventEmitter } from 'node:events';
import { TYPE } from '../link/frame.js';
import { BUTTON, UI_STATE, approvalReqPayload, parseApprovalRes, parseButton, uiPayload } from '../link/messages.js';

const BUTTON_EVENT = new Map([
  [BUTTON.CANCEL, 'cancel'],
  [BUTTON.STOP, 'stop'],
  [BUTTON.DISMISS, 'dismiss'],
  [BUTTON.SWITCHING, 'switching'],
]);

export function createUi({ link, log = () => {} }) {
  const events = new EventEmitter();
  let base = { state: UI_STATE.IDLE }; // what the screen shows when nothing is over it
  let approval = null; // {id, tool, preview} while one is on the screen

  const sendBase = () => link.send(TYPE.UI, uiPayload(base));
  const sendApproval = () => link.send(TYPE.APPROVAL_REQ, approvalReqPayload(approval));

  // `fields`: project, text, elapsedMs.
  function show(state, fields = {}) {
    base = { state, ...fields };
    if (!approval) sendBase();
  }

  function showApproval({ id, tool, preview }) {
    approval = { id, tool, preview };
    sendApproval();
  }

  // The approval `id` is over, answered or not. The screen it covered goes out as it is now.
  function clearApproval(id) {
    if (!approval || approval.id !== id) return;
    approval = null;
    sendBase();
  }

  link.on('hello', () => (approval ? sendApproval() : sendBase()));

  link.on('frame', (f) => {
    if (f.type === TYPE.BUTTON) {
      const button = parseButton(f.payload);
      const name = button && BUTTON_EVENT.get(button.event);
      if (name) events.emit(name);
      else log(`ui: button ${button ? button.event : '(empty)'} is not one this bridge knows`);
    } else if (f.type === TYPE.APPROVAL_RES) {
      const res = parseApprovalRes(f.payload);
      if (res) events.emit('verdict', res);
      else log('ui: a short APPROVAL_RES was ignored');
    }
  });

  return {
    show,
    approval: showApproval,
    approvalClear: clearApproval,
    current: () => ({ base: { ...base }, approval: approval ? { ...approval } : null }),
    on: (name, listener) => events.on(name, listener),
  };
}
