# 0.6.0 call sounds and focused regression checks

Base: `2100c6342edcd5af541a8f6bf2f74f6294adefa2`, existing PR #150.

## User field report — 2026-09-26

Following the 2100c634 installer handoff, the user reported that the in-app update worked and that they could hear call audio. The established test environment is two PCs on separate Internet networks. This is user-reported partial field evidence, not an independently recorded A/B trace or approval of every voice mode, direction, device, mute/reconnect or protected-room scenario. It does not establish a TURN requirement, close all audio gates, authorize a Release, or change the 56/67 Real Internet Test fraction.

## This package

- Original local synthesized double-beep outgoing ringback and a soft four-note incoming ringtone; no remote assets, microphone capture or connection to an RTP sender.
- Separate enable switches, bounded volume, 1.8-second previews and Stop preview under audio settings. Respect notification mute, voice opt-out and deafen. Preview cannot interrupt an active call.
- Feedback follows the private controller's session callbacks rather than DOM polling. Stop sources on accept/join, reject/end, error, reconnect, offline and unload; repeated session events do not stack loops. Late autoplay resume cannot resurrect ended calls.
- Settings are idempotent, preserve focus, survive unavailable local storage without crashing, and add no new MutationObserver.
- Reject a second local call before overwriting the active peer or remote playback state. Reset private media and panels on offline as well as network error.

## Verification

`node scripts/test-call-sounds.mjs` is included by the existing startup audit. Local verification passed 34 lifecycle/PCM checks, runtime tests of the actual private-UI busy guard and offline cleanup, and 15 real-browser native-buffer/settings checks per locale (PL/EN). Compilation uses the installed TypeScript CLI with an explicit temporary source root, not the removed legacy compiler API. Local compiler: TypeScript 5.8.3; repository TypeScript 7 and the complete app remain CI gates. Browser checks do not claim physical-speaker playback or a new cross-Internet audio result.

## Tester handoff

Keep 0.6.0 on the same test-update branch. Do not mutate 0.5.1, publish a GitHub Release, or resume the paused hourly automation. After exact-head Windows/Linux/RustSec success and installer integrity qualification, update both clients through the existing verified test channel. Check outgoing/incoming sounds, stop on accept/reject/end, volume/toggles, notification mute and reconnect, then reconfirm speech. No installer is qualified by this note alone.
