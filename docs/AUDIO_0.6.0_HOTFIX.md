# 0.6.0 audio negotiation and action-layout hotfix

Base: `84ff7856031b3a155b71a286b55a3bdf4038c85a`, existing PR #150.

## Reproduced defect

`WebRtcAudioPeer.requireSdp()` used `trim()` and returned an unterminated SDP description. A real Chromium peer rejects the final attribute with `OperationError: Failed to parse SessionDescription ... Invalid SDP line`. Mock peers accepted these strings and did not expose the defect. Normalize line endings and restore the final CRLF at both offer/answer boundaries. Both private and room/WORLD controllers share this engine. Empty descriptions still fail closed; authenticated secure-control signaling, STUN configuration, microphone consent and opt-out behavior are unchanged.

## Layout

The old identity selector relied on the nickname container being the last child; optional peer-action buttons invalidated that assumption. Give identity and actions explicit grid positions, constrain long names, keep file/chat/audio actions visible, allow the main header to grow when buttons wrap, and reserve call/close columns in private chat. Keep the participant panel reachable below 1080px instead of hiding it. The new stylesheet adds no DOM observers.

## Verification and limitations

`node scripts/test-audio-sdp-layout.mjs` compiles the actual engine and exercises native Edge/Chromium SDP parsing, listen-first negotiation, bidirectional transceiver directions, mute/unmute, sender replacement, ICE credential restart and cleanup. It also loads the actual repository styles and tests action bounds at 1600, 1280, 1024 and 820px. This gate is included by the existing startup audit.

Local native SDP/track checks passed (30 assertions). Local layout fixtures passed using the original layout excerpts plus the new stylesheet; full repository CSS is checked in Windows CI. These are not audible-speech or cross-Internet acceptance. A local media probe produced no usable ICE path in the restricted tool browser, so no RTP delivery or physical microphone/speaker result is claimed. The user's reported silence has a reproduced SDP bug; it does not by itself establish `TURN required`.

## Update handoff

Keep version 0.6.0 on `beta/0.6.0-audio-calls`; the existing test updater distinguishes builds by source commit. It selects successful Windows CI artifacts and verifies the outer GitHub digest plus BUILD_INFO/installer SHA-256 before launching the installer. Do not publish a GitHub Release, modify 0.5.1 or resume the paused hourly automation.

After exact-head Windows/Linux/RustSec success and installer integrity qualification, test through **Check for updates -> Download and install** on both PCs. Confirm both report the new build, then test private A-to-B and B-to-A speech, WORLD/room listen and explicit speak, mute/deafen, long nicknames and restart. If audio still fails, record whether the call reaches connected or stalls in joining/reconnecting/error before diagnosing NAT/TURN. Keep the 56/67 Real Internet Test fraction unchanged until its actual evidence gates pass.
