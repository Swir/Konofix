# 0.6.0 Audio Beta readiness and field fixes

## Owner request — 2026-09-27

The owner explicitly authorized a **0.6.0 Audio Beta GitHub Release**, not a stable release. They reconfirmed the in-app updater works and reported a receiver progress regression for PNG and difficulty leaving a room. Prior user-reported audible speech on two PCs connected through separate Internet networks remains partial field confirmation, not proof of every WORLD/protected-room/device/reconnect path.

## Reproduced and corrected

- A delayed `accept_file` IPC reply could overwrite newer `file-transfer` progress/completion. The old UI reproduces completed PNG -> receiving/0% with controlled event ordering. Initial `offer_file` replies share the same race. Replies now preserve already-observed events; terminal and backwards updates cannot rewind the card.
- Intermediate progress updates only the Transfers panel instead of replacing all room actions and the chat composer. Unavoidable same-room renders preserve the unsent draft and focused selection and do not steal focus from dialogs. Percentages remain backend-driven; no fake timer or success on failed/cancelled transfers.
- An explicit localized Leave room -> WORLD action is visible outside WORLD. An exit clicked during an acknowledged entry/create is queued behind that operation. Failed exits retain the existing room and can be retried; stale sessions cannot change selection.
- Room voice now finishes local leave without waiting for end-signal delivery to unreachable peers. A late completion cannot reset a new call. Leaving a text room also stops its room voice; late join results cannot reopen a cancelled panel. Existing authenticated control transport and microphone consent are unchanged.
- Small layout polish adds numeric accessible transfer progress, bounded metadata, fixed sidebar actions, and corrects the old 0.4 startup label. This is not a broad visual redesign.

## Verification and remaining gates

`test-transfer-room-ui.mjs` runs real Chromium/Edge DOM with actual core and room-UI handlers, replacing IPC/controller networking deliberately. PL/EN each pass 62 assertions. The old receiver source is rejected at the delayed acceptance race; the old room UI is rejected because local leave waits for remote delivery. Existing room-transition rejection/concurrency/stale-session checks remain enabled. This evidence is UI/runtime regression coverage, **not a new physical two-PC network or microphone/speaker test**.

Before publishing `v0.6.0-beta.1`: require full exact-head Windows/Linux/RustSec success, installed-app startup smoke, artifact and installer SHA-256/provenance qualification. **Critical field gate added 2026-09-27:** a clean client with no saved peers or manual bootstrap must discover a second clean client across an independent Internet network through at least one verified public Konofix bootstrap/relay from the current pool; WORLD, a room, private chat/file and private-audio signaling must then work on that exact candidate. An empty/unreachable pool is release-blocking even when LAN tests and source CI are green. Preserve existing published versions and stable 0.5.1. Set `prerelease=true`, never make this the latest stable. The 56/67 Real Internet Test score is unchanged until real evidence closes a canonical gate.

## NEXT — room creator moderation (separate finite follow-up)

The requested creator Admin / kick / ban / unban feature is accepted into the next-room-moderation backlog, not represented as already implemented in Audio Beta. Bind owner authority to authenticated Peer ID, not a nickname or client-only badge. Enforce owner-authorized, revision/replay-protected membership changes at room entry and room text/file/voice boundaries; provide a visible removal/ban reason and an unban list. Cover non-owner forgery, stale revisions, reconnects and protected rooms before enabling it. In this accountless P2P model an identity reset can evade a Peer-ID-only ban; do not promise permanent person-level enforcement without an explicit identity policy.

The hourly Konofix development automation remains active until the user explicitly stops or changes it.
