<!-- KONOFIX-BETA-PREVIEW -->
# Konofix Chat 0.5.1 Beta 1 — Transfer & Private Attention Preview

This prerelease is the user-requested 0.5.1 Windows stabilization build for manual testing after the frozen 0.4.3, 0.4.4 and 0.5.0 candidates. **Global Beta qualification remains 56/67 = 83.6%.**

## What changed

- Room/WORLD downloads now create an immediate receiver-side requesting/connecting entry in Transfers, then reconcile that placeholder to the real incoming P2P transfer and live progress by transfer/public-offer identity.
- Request placeholders are removed on terminal error or expiry so stale download rows do not survive failed claims.
- The first/new incoming private 1:1 message now shows a prominent safe-rendered preview modal with Open and Ignore actions.
- Ignore applies only to that peer for the current session; manually opening the conversation clears the ignore state.
- Settings now include a switch for allowing new private conversations. When disabled, new incoming private messages are rejected fail-closed over the authenticated direct secure-control channel with a sender-visible error and no GossipSub/public fallback.
- Existing direct private file attachments, room-scoped file offers, password rooms, incumbent duplicate-nickname handling, emoji/colors, WORLD file/image sharing, SHA-256 verification, no-clobber finalization, cancellation/limits and safe rendering remain required.

## Manual test focus

1. From WORLD and from a room, click Download on a file card and confirm the receiver immediately sees requesting/connecting state before bytes arrive, then real live progress and completion in the same transfer row.
2. Force a failed/expired claim and confirm the placeholder is cleaned up instead of remaining stuck.
3. Send a first/new private message to a peer with no open conversation; verify the safe preview modal appears, Open enters the conversation, and Ignore suppresses that peer only for the current session.
4. After Ignore, manually open that peer and verify notifications resume for subsequent messages.
5. Disable new private conversations in Settings and verify a new sender receives a clear rejection through the direct authenticated channel; no public/GossipSub fallback may appear.
6. Re-check private attachments, room-scoped offers, password-room authorization, duplicate nickname rejection, emoji/colors, WORLD file/image sharing, cancellation, size limits, SHA-256 and no-clobber completion.

Keep the installer/ZIP, BUILD_INFO.json and checksum files together and report the exact source commit from BUILD_INFO.json with any failure.
