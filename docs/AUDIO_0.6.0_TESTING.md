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
- Protected-room voice must preserve room authorization before media signaling is allowed.

## Release rule

Development builds and CI artifacts may be produced for testing. Do not publish a GitHub Release, prerelease or stable release until the project owner explicitly requests it.
