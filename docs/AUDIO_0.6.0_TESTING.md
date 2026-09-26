# Konofix 0.6.0 Audio — Development Test Plan

This document describes the active 0.6.0 development target. It is **not** a published release.

## Scope

- authenticated private 1:1 audio calls,
- opt-in voice for #WORLD,
- opt-in voice for regular and password-protected rooms,
- explicit listen / want-to-speak room intent,
- microphone mute and incoming-audio deafening,
- chat and notification mute preferences,
- complete voice opt-out,
- device selection, permission errors, reconnect and call-state feedback,
- participant/speaking indicators,
- bounded invite/signaling anti-spam controls.

## Transport rules

- Private call signaling uses the authenticated direct secure-control channel.
- WebRTC SDP and ICE payloads are size-bounded, replay-protected and bound to the authenticated peer identity and current presence.
- No private voice signaling falls back to GossipSub/public chat.
- WORLD/room participation is opt-in; joining a text room never starts a microphone or incoming audio.
- Default WebRTC media ICE uses Cloudflare's public STUN endpoint `stun:stun.cloudflare.com:3478` so clients on different Internet connections can discover server-reflexive candidates; STUN does not carry Konofix signaling or relay voice media.
- A successful STUN-assisted direct path is still network-dependent. If a restrictive NAT/firewall prevents direct ICE connectivity, record the failure as TURN-required rather than weakening authenticated signaling or claiming the Internet audio gate passed.
- A room voice invite is accepted only when the receiving client explicitly joined the same voice scope.
- Protected-room voice must preserve room authorization before media signaling is allowed.

## Exact-build qualification

Use the Windows CI artifact from the exact PR head being tested. Record the full source commit before testing and keep both clients on that same build. Do not credit any checklist item from source-only or CI-only evidence when the step below requires real microphones, speakers or two running clients.

### Two-client baseline

1. Start two clean Konofix clients on separate Windows sessions or computers.
2. Connect both to the same P2P network and confirm normal text chat, private chat and file/image sharing still work.
3. Confirm neither client captures a microphone merely by connecting, entering a text room or receiving presence.
4. Run the audio cases below in both directions where applicable.

### Private 1:1

- Start a call from Client A to Client B and confirm `calling` / `ringing`.
- Before B accepts, confirm B's microphone is not active.
- Accept and confirm `joining` then `connected` on both clients.
- Verify two-way speech, microphone mute/unmute, incoming-audio deafen/undeafen and device selection.
- Disconnect/reconnect the network briefly and confirm `reconnecting` either recovers to `connected` or fails clearly without a stuck microphone.
- End the call from each side and confirm `ended`, remote audio stops and microphone capture is released.
- Reject one incoming call and confirm no microphone capture starts.

### #WORLD voice

- Join voice on A first and confirm listen-only mode starts with no microphone capture.
- Join voice on B; confirm both clients show the participant count.
- Use `Want to speak` on A and confirm only then the microphone activates.
- Verify B marks A as speaking, then verify microphone mute clears the speaking indication.
- Verify deafen on B silences incoming audio without forcing A to mute or leave.
- Leave voice and confirm text #WORLD remains connected and usable.

### Regular room voice

- Put both clients in the same temporary room and explicitly join voice.
- Verify listen-first, want-to-speak, mute/deafen, participant/speaker state, device selection and leave.
- Keep a third client outside that room and confirm it cannot become an active room-voice participant without explicitly joining the matching voice scope.

### Password-protected room voice

- Create a password-protected room, authorize Client B normally and join voice on both clients.
- Verify the same controls as a regular room.
- With an unauthorized client, confirm protected-room voice signaling is rejected and no microphone/audio session starts.

### Opt-out and quiet controls

- Disable private audio calls and confirm new incoming private calls are rejected.
- Disable WORLD/room voice while connected to voice and confirm the active room voice is left and later room invites are rejected.
- Enable `Mute chat` with notifications still enabled: chat/message composers hide, stored messages remain, and notifications are still allowed.
- Enable `Mute notifications` with chat still enabled: chat remains usable while private-message and incoming-call popups are suppressed.
- Re-enable each control and confirm the state is reversible without reconnecting the P2P session.

### Permission and device errors

- Deny microphone permission, choose `Want to speak` or accept a private call and verify a clear permission error with no stuck capture.
- Test with no usable input device when possible and verify the missing-device message.
- Switch between two available microphones during a connected call/room session and confirm audio continues from the newly selected device.

### 0.5.1 regression pass

Before requesting any release, re-check the stable 0.5.1 workflows on the same 0.6.0 candidate:

- duplicate nickname protection,
- #WORLD and room text chat,
- regular and password-protected room entry,
- private 1:1 text conversations and notifications,
- WORLD/room/private file transfer plus image preview/download,
- transfer progress/cancel/SHA-256/no-clobber behavior,
- nickname colors and emoji rendering,
- resize/HiDPI and normal disconnect/reconnect.

## Acceptance evidence

For each manual case record: exact commit, client A/B environment, microphone/output devices, PASS/FAIL, and a short note for any failure. The 0.6.0 Audio roadmap remains unchanged until the corresponding real acceptance evidence exists. User-led audio approval remains a separate final gate.

## Release rule

Development builds and CI artifacts may be produced for testing. Do not publish a GitHub Release, prerelease or stable release until the project owner explicitly requests it.
