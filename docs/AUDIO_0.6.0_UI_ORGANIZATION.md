# 0.6.0 private room exit and UI organization

Base: `a2447d51ea5e6f3c4eda4e9d6825a1a79cb53f0f`, PR #150.

The owner clarified that the reported leave problem concerns the private text
room, not only its voice channel. The base contains the acknowledged
Leave room -> WORLD route, queued exit, room-voice cleanup and PNG reply-race
fixes. Its exact-head Windows #1062, Linux #804 and RustSec #446 passed.
This does not replace a fresh user test of protected-room exit.

This follow-up reorganizes settings into Audio / Privacy / Updates / Network
and applies one restrained dark-blue hierarchy to login, chat, participants,
transfers, private chat and voice panels. Room-owner password controls occupy
an explicit sidebar column instead of overlapping room rows. Leave room stays
visually distinct. Existing controls are moved, never cloned or rewritten;
their listeners, values and focus survive update responses and late modules.
The settings organizer reuses the updater's existing coalesced DOM lifecycle,
adds no observer/polling and changes no network, room authorization or media.
It includes keyboard tab navigation, Escape, visible-panel focus trapping and
focus restoration. An unavailable optional module has an explicit empty state.

Local Chromium verification: 46 actual-settings/updater DOM assertions per
locale/width (PL/EN at 1280/820/360px), 276 total; unchanged renders write no
child nodes. Missing updater hook and cloned-control mutations are rejected.
The new settings module passes standalone strict TypeScript 5.8.3 checking.
Rendered settings fixtures at 1280px and 360px were inspected locally; they are
not screenshots of a Windows installer. The full repository CSS cascade,
including the new stylesheet and pointer reachability of Leave room, remains
covered by the existing native SDP/layout Windows CI gate. Core PNG/room-exit,
sound, mute and updater regressions remain enabled without weakening them.

Require full exact-head Windows/Linux/RustSec and installer SHA-256/provenance
qualification before handing off this build or publishing the owner-authorized
Audio Beta prerelease. Do not mutate 0.5.1, merge to main, resume the paused
hourly automation or claim new Internet audio evidence. The 56/67 Real Internet
Test percentage remains unchanged. Room-owner kick/ban/unban remains the
separate accepted NEXT package, not an implemented capability of this patch.
