// Manual bounded network probe. It publishes one random, ephemeral event per
// configured relay and reports the relay's NIP-01 OK acknowledgement.
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const relays = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
];

function probe(url) {
  return new Promise(resolve => {
    const secret = generateSecretKey();
    const marker = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({
      kind: 28_733,
      created_at: now,
      tags: [['t', `konofix-probe-${marker}`], ['expiration', String(now + 30)]],
      content: JSON.stringify({ v: 1, probe: marker }),
    }, secret);
    const receiver = new WebSocket(url);
    let sender;
    let accepted = false;
    let delivered = false;
    let detail = '';
    const finish = () => {
      clearTimeout(timer);
      try { receiver.close(); } catch {}
      try { sender?.close(); } catch {}
      resolve({ url, accepted, delivered, detail });
    };
    const complete = () => { if (accepted && delivered) finish(); };
    const timer = setTimeout(() => { detail ||= 'timeout'; finish(); }, 12_000);
    receiver.addEventListener('open', () => {
      receiver.send(JSON.stringify(['REQ', `probe-${marker.slice(0, 12)}`, {
        kinds: [28_733], '#t': [`konofix-probe-${marker}`], since: now - 1,
      }]));
      setTimeout(() => {
        sender = new WebSocket(url);
        sender.addEventListener('open', () => sender.send(JSON.stringify(['EVENT', event])));
        sender.addEventListener('message', message => {
          try {
            const frame = JSON.parse(String(message.data));
            if (Array.isArray(frame) && frame[0] === 'OK' && frame[1] === event.id) {
              accepted = frame[2] === true;
              detail = String(frame[3] ?? '');
              complete();
            }
          } catch {}
        });
        sender.addEventListener('error', () => { detail ||= 'sender websocket error'; });
      }, 250);
    });
    receiver.addEventListener('message', message => {
      try {
        const frame = JSON.parse(String(message.data));
        if (Array.isArray(frame) && frame[0] === 'EVENT' && frame[2]?.id === event.id) {
          delivered = true;
          complete();
        }
      } catch {}
    });
    receiver.addEventListener('error', () => { detail ||= 'receiver websocket error'; finish(); });
  });
}

const results = await Promise.all(relays.map(probe));
for (const result of results) console.log(JSON.stringify(result));
if (results.filter(result => result.accepted && result.delivered).length < 2) process.exitCode = 1;
