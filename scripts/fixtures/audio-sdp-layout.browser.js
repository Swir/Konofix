// Runs against the actual compiled WebRtcAudioPeer and actual repository CSS.
// Checks browser SDP parsing, not Internet/physical-microphone/media delivery.
const checks = [];
function check(value, name) { if (!value) throw new Error(name); checks.push(name); }
async function negotiation(listenFirst) {
  const connections = [], streams = [], contexts = [];
  const peers = [0, 1].map(() => new WebRtcAudioPeer({ iceServers: [] }, {}, config => {
    const pc = new RTCPeerConnection(config); connections.push(pc); return pc;
  }));
  const attach = async side => {
    const context = new AudioContext(); contexts.push(context);
    const destination = context.createMediaStreamDestination(); streams.push(destination.stream);
    await peers[side].setLocalStream(destination.stream);
    return destination.stream.getAudioTracks()[0];
  };
  const exchange = async () => {
    const offer = await peers[0].createOffer();
    check(offer.endsWith('\r\n'), 'offer retains final CRLF');
    const answer = await peers[1].acceptOffer(offer.trim().replace(/\r\n/g, '\n'));
    check(answer.endsWith('\r\n'), 'answer retains final CRLF');
    await peers[0].acceptAnswer(answer.trim());
    check(connections.every(pc => pc.signalingState === 'stable'), 'native browser accepts offer and answer including trimmed/LF transport');
  };
  try {
    if (listenFirst) {
      await exchange();
      check(connections.every(pc => pc.getSenders().every(sender => !sender.track)), 'listen-only negotiation opens no microphone/sender track');
    }
    const first = await attach(0);
    await attach(1);
    await exchange();
    check(connections.every(pc => pc.getTransceivers().some(t => t.currentDirection === 'sendrecv')), 'private/room speak negotiates bidirectional audio');
    peers[0].setMuted(true); check(!first.enabled, 'mute disables real sender track');
    peers[0].setMuted(false); check(first.enabled, 'unmute restores real sender track');
    const replacement = await attach(0);
    check(connections[0].getSenders().some(sender => sender.track === replacement), 'input change replaces real RTP sender track');
    const before = connections[0].localDescription.sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1];
    peers[0].restartIce(); await exchange();
    const after = connections[0].localDescription.sdp.match(/a=ice-ufrag:([^\r\n]+)/)?.[1];
    check(Boolean(before && after && before !== after), 'ICE restart produces fresh credentials');
    let rejected = false;
    try { await peers[1].acceptOffer('   '); } catch { rejected = true; }
    check(rejected, 'empty SDP is rejected');
  } finally {
    peers.forEach(peer => peer.close());
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    await Promise.all(contexts.map(context => context.close()));
    check(connections.every(pc => pc.connectionState === 'closed'), 'hang-up closes real peer connections');
  }
}

await negotiation(false);
await negotiation(true);

// Deliberately longer than accepted nicknames to stress min-content sizing.
const nick = 'LongNickname_'.repeat(18);
const styles = document.createElement('style'); styles.textContent = REPOSITORY_CSS; document.head.append(styles);
const fixture = document.createElement('div'); document.body.append(fixture);
fixture.innerHTML = `<main class="chat-shell">
  <aside class="sidebar glass"><div class="sidebar-bottom"><div class="me-info"><strong>${nick}</strong></div><button>⚙</button><button>⏻</button></div></aside>
  <section class="chat-main glass"><header class="chat-header"><div><h2>${nick}</h2></div><div class="header-actions"><button data-room-audio-join class="ghost">Dołącz do głosu</button><span class="live">2 online</span><button class="ghost">Udostępnij plik</button><button class="ghost">Udostępnij obraz</button><button id="leaveRoom" class="ghost">Opuść pokój</button></div></header><div class="messages"></div><footer class="composer"><input><button class="send">➤</button></footer></section>
  <aside class="users glass"><div id="peerList"><div class="user"><div class="avatar">L</div><div><strong>${nick}</strong><span>Online</span></div><button data-private-audio-peer="a" class="mini-private-audio">📞</button><button data-private-peer="a" class="mini-private">💬</button><button data-send-peer="a" class="mini-file">📎</button></div></div></aside>
</main>`;
const contained = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
const row = document.querySelector('#peerList .user');
for (const button of row.querySelectorAll('button')) {
  check(contained(row.getBoundingClientRect(), button.getBoundingClientRect()), 'long nickname preserves peer action bounds');
  check(getComputedStyle(button).opacity === '1', 'peer action is visible without mouse hover');
  check(button.getBoundingClientRect().height >= 36, 'peer action keeps usable target size');
}
const header = document.querySelector('.chat-header');
check(contained(document.querySelector('.chat-main').getBoundingClientRect(), header.getBoundingClientRect()), 'chat grid must contain the full header, not just its actions');
for (const button of header.querySelectorAll('button')) check(contained(header.getBoundingClientRect(), button.getBoundingClientRect()), 'main header contains every action');
const exit = document.querySelector('#leaveRoom'), exitRect = exit.getBoundingClientRect();
check(document.elementFromPoint(exitRect.x + exitRect.width / 2, exitRect.y + exitRect.height / 2)?.closest('#leaveRoom') === exit, 'private room exit remains reachable by pointer');
fixture.innerHTML = `<div class="private-chat-wrap"><section class="private-chat-modal"><header class="private-chat-head"><div><h3>${nick}</h3><span class="private-peer-status">Połączono</span></div><button data-private-audio-chat-call>📞</button><button data-private-close>✕</button></header><div class="private-messages"></div><footer></footer></section></div>`;
const head = document.querySelector('.private-chat-head');
for (const button of head.querySelectorAll('button')) check(contained(head.getBoundingClientRect(), button.getBoundingClientRect()), 'long private nickname preserves call and close buttons');
fixture.remove(); styles.remove();
return { pass: true, checks: checks.length, scope: 'native SDP + track controls + layout; no two-PC Internet or audible speech evidence' };
