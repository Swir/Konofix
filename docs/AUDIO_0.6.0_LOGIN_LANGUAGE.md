# 0.6.0 login viewport and language preference

Base: `6661606d61324f1b0f82ccd454049ee746dd4f1c`, existing PR #150.

## Field report

The owner reports that sending files and leaving the private text room now
work. This is partial user confirmation of the previous build, not new proof
of every audio/room/network scenario. They report a clipped login page in the
initial window, a briefly visible duplicate nickname, and request a manual
language override. Real Internet Test remains 56/67 (83.6%).

## Implemented in this checkpoint

- A viewport-bounded login scroll container loaded with the startup layout,
  not dependent on an optional module succeeding. Compact card spacing and
  bounded color swatches fit the default window; shorter windows, scaling
  and long update errors remain scrollable without maximizing. The late
  professional stylesheet does not override the more specific login rules.
- Language selection above the settings tabs: Automatic/system plus the seven
  currently supported languages, using native names and the existing
  `konofix.locale` key. Changes are explicit and persist only on Save.
  Automatic removes the override. The existing startup resolver and English
  missing-translation fallback remain authoritative.
- Changes apply at the next app start. No reload, restart, reconnect, microphone
  operation, observer, polling or alteration of active calls/transfers occurs.
  Save failures remain visible/retryable; repeated settings lifecycle events
  preserve the same controls and keyboard focus.

## Verification

New browser regression uses the actual login function, language module and
startup locale resolver, with no P2P/installer side effects. PL/EN are exercised
at 1280x760, 1280x620, 980x620, 1024x608, 853x507 and 360x600. Coverage includes
pointer reachability, long update errors, all supported overrides, automatic
fallback, persistence failure/retry, reopening and idempotent mounting.

Local Chromium passed 758 assertions across these twelve runs, using the
fetched login/resolver excerpts and a reduced, explicitly labelled CSS host.
Missing-layout and broken-save mutations were rejected. Standalone strict
TypeScript 5.8.3 checking passed. Local checks are NOT a full app build or a
Windows display-scaling test. The mandatory CI gate reads the full repository
renderer/CSS, including the late professional stylesheet; existing audio,
room exit, PNG, updater and settings gates remain enabled.

## Still open: duplicate nickname appearance

Inspection found the specific incumbent-side path in `src-tauri/src/lib.rs`:
a valid authenticated Presence is checked by `check_nick_conflict`; when the
incumbent correctly wins, execution still inserts the losing peer and emits
`peer-online`. The subsequent rejection/removal explains the transient row.
**This checkpoint does not change that backend path or claim to fix it.**
The next correction must suppress the rejected duplicate before presence/UI
admission while preserving canonical-nickname/session-age arbitration and
source authentication, with regression coverage for incumbent/newcomer and
near-simultaneous logins. Do not replace it with an arbitrary display delay.

Full exact-head Windows/Linux/RustSec and installer integrity/startup
qualification remain required before a fresh handoff or the previously
owner-authorized Beta prerelease. Stable 0.5.1, published builds and main are
unchanged. The paused hourly automation is not resumed.
