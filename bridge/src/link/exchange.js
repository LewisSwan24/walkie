// What the commands that talk to the S3 once (pair, wifi, relay) share: waiting for an event for a while, and sending one frame and
// waiting for its answer.

// True when `event` came before `ms` ran out.
export function arrivesWithin(emitter, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      resolve(false);
    }, ms);
    const onEvent = () => {
      clearTimeout(timer);
      resolve(true);
    };
    emitter.once(event, onEvent);
  });
}

// Sends one frame and resolves with what `pick` makes of the first frame of that type that it accepts (a falsy result means "not the
// answer"), or null after `answerMs`. The frame is sent once: a request that changes what walkie holds is not safe to repeat.
export function askOnce(link, type, payload, pick, answerMs) {
  return new Promise((resolve) => {
    let giveUp;
    const finish = (answer) => {
      clearTimeout(giveUp);
      link.off('frame', onFrame);
      resolve(answer);
    };
    const onFrame = (f) => {
      if (f.type !== type) return;
      const answer = pick(f.payload);
      if (answer) finish(answer);
    };
    link.on('frame', onFrame);
    giveUp = setTimeout(() => finish(null), answerMs);
    link.send(type, payload);
  });
}
