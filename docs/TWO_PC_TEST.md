# Two-PC Windows test — Poland and Norway

Use this short procedure for two actual installations. It collects observations; it never grants WAN, Global Beta or production qualification automatically. Preserve both the original reported LAN-to-LTE **WAN FAIL** and the later exact-candidate limited WORLD text **PASS** ([#165](https://github.com/Swir/Konofix/issues/165)); the latter did not record route subtype or restart recovery. Start each new retest as **NOT RUN**, without replacing earlier observations.

## 1. Match the build

Candidate 0.5.2 is published as a prerelease bound to the accepted exact source, workflow and installer checksum. Both people download the same release and compare its source SHA and checksum. The limited physical WORLD text PASS does not close the broader route/restart evidence or the earlier KNP lifecycle investigation.

After verifying and extracting the inner release ZIP as below, compare the installer's SHA-256 with its entry in BUILD_INFO.json:

```powershell
Get-FileHash -LiteralPath ".\bundle\nsis\Konofix Chat_0.5.2_x64-setup.exe" -Algorithm SHA256
```

Do the same for the inner release ZIP named `Konofix-Chat-0.5.2-Windows-<source-SHA>.zip`. The outer Actions download is a different ZIP with a different hash. Extract the inner release ZIP into a new folder. Compare `BUILD_INFO.json` version, full commit and workflow on both PCs. Never combine installers, scripts or evidence from different builds.

Close old Konofix instances, install the setup, then launch **Konofix Chat** from Start. Netprobe and Node are optional command-line tools, not the chat window. Keep the previous trusted installer for rollback; do not delete profile keys. A rollback starts a new evidence folder and must not continue the current test record.

## 2. Create a new private observation folder

Keep observations outside the sealed extracted bundle. On each PC, run this from that bundle's root. It creates a fresh directory and opens the initial record with CreateNew: an existing record cannot be overwritten.

```powershell
$ErrorActionPreference = 'Stop'
$info = Get-Content -LiteralPath .\BUILD_INFO.json -Raw | ConvertFrom-Json
$label = 'PL' # Use NO on the Norway PC.
$run = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N')
$folder = Join-Path ([Environment]::GetFolderPath('MyDocuments')) ("Konofix-test-" + $label + "-" + $run)
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
$record = [ordered]@{
  schema = 1; purpose = 'manual-two-PC-observations'; status = 'NOT RUN'
  participant = $label; started_utc = [DateTimeOffset]::UtcNow.ToString('o')
  version = $info.version; source_commit = $info.commit; workflow_run = $info.workflow_run
  build_info_sha256 = (Get-FileHash -LiteralPath .\BUILD_INFO.json -Algorithm SHA256).Hash.ToLowerInvariant()
  scenarios = @('LAN mDNS', 'automatic WORLD text', 'WAN direct', 'WAN circuit', 'Wi-Fi/LTE recovery', 'optional KNP') | ForEach-Object {
    [ordered]@{ name = $_; status = 'NOT RUN' }
  }
}
$bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Depth 5))
$stream = [IO.File]::Open((Join-Path $folder 'START.json'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
$folder
```

Keep START.json unchanged. Save screenshots and notes under new names containing UTC time and PL/NO. For corrections, add a new note referring to the old one; do not replace originals. Record the shared archive hash, Windows version, timezone, country/network label and whether a reachable first contact was available. Do not collect private messages unrelated to the test.

## 3. Primary chat first

Use different nicknames. Test public WORLD with harmless unique markers, for example `PL-<run>-001` and `NO-<run>-001`; capture the received text at both ends. WORLD is public to participants, not a private E2E conversation.

- **LAN baseline:** two physical PCs on the same multicast-capable LAN, fresh network settings/cache and no pasted addresses. Require automatic discovery, observed direct route and messages both ways. Poland and Norway on separate networks cannot substitute for this LAN scenario; leave it NOT RUN if unavailable. Guest isolation or blocked multicast is a failure/environment finding, not permission to paste an address and call zero-config PASS.
- **Automatic Internet WORLD retest:** PC A uses Wi-Fi/wired Internet in Poland; PC B uses LTE or another independent operator (Norway if available). Start with fresh application network settings/cache and no pasted contacts. Public discovery and bounded participant-relay consent are selected by default on both PCs; keep them selected and record any opt-out separately. The direct-first Amino path and signed multi-relay WORLD fallback start together. A dedicated Node or operator VPS is not required. Both users must appear in WORLD and receive each other's unique markers. Record the **Public WORLD relays** count and whether the remote user shows the globe marker (relay-only text). Record FAIL if automatic presence or either message direction does not work, preserving #165. A DHT connection, manual invitation, open WebSocket or peer count without received markers is never automatic-WORLD PASS.
- Open **Network settings** on both PCs after connection and reopen it to refresh. Record the public WORLD relay count. If a native route also forms, record the intended recipient's full PeerID and observed `direct TCP`, `direct QUIC` or `circuit` route. A relay-only Nostr identity is deliberately not a native PeerID and cannot authorize direct operations. A native relay reservation alone is not an established circuit, and this UI does not trace the path of each message.
- Exchange WORLD markers both ways. If a native route exists, also create/join a temporary room, transfer a harmless file with approval and compare its SHA-256. If only the globe-marked public-text path exists, record room/file as BLOCKED or NOT RUN rather than pretending those bytes used the fallback. Restart one application and repeat. Then move PC B from Wi-Fi/LAN to LTE while the application remains open: record the old native route disappearing, public-relay/discovery recovery and new WORLD markers received both ways without pasted contacts. A later clean restart is a separate observation, not evidence that in-session network recovery worked.
- **Controlled relay case:** only when direct reachability is actually unavailable and a reachable participant relay exists, record the failed direct attempt and actual circuit to the intended recipient, then exchange application messages both ways. Do not disable general host protection to manufacture a test. Record removal/replacement of the relay and direct recovery where supported. A local or Netprobe Ping alone is not an application-message PASS.

Direct-first for remembered reconnects and admitted cold-start contacts uses bounded candidate plans; native DHT, explicit bootstrap and DCUtR remain active. The public Nostr path supplies WORLD presence/text across restrictive CGNAT. In the 0.5.3 candidate it also supplies recipient-addressed NIP-44 private text and explicitly accepted encrypted files up to 2 MiB; temporary-room control still needs a native direct or compatible participant circuit path. An optional native operator pool is one alternative, never a mandatory VPS or history authority. Default-on discovery does not prove a new candidate; only recorded exact-build physical acceptance can do that.

## 4. Optional KNP after primary chat

Follow KNP_CHAT_BETA.md. Both peers explicitly verify each other's NodeID and reachable UDP endpoint and admit the contact. Require real text plus recipient-application acknowledgement; transport delivery alone is insufficient. Return to WORLD, stop only KNP and confirm WORLD still works. Reopen the profile and verify identity continuity; primary disconnect must also stop its KNP child. Capture results separately from libp2p, with no implicit PeerID/NodeID mapping.

## 5. Return observations without overwriting

For each scenario, write what actually happened: NOT RUN, BLOCKED, FAIL or observed PASS, UTC window, both recipient markers, intended PeerIDs/routes, relevant screenshots, file hash and reconnect behavior. Hash each finalized attachment with Get-FileHash and record the filename/digest in a new note. Keep originals; make separately named redacted copies for sharing and hash those copies too.

Send the small reviewed set privately to the project owner. Never upload entire application/profile directories, identity.key, node-identity.key, credentials, unrelated conversations or automatic unreviewed diagnostic dumps. Public IPs, PeerIDs and screenshots can reveal network details; disclose only what the test needs. Do not post raw evidence to a public issue by default.

These manual observations are not the sealed promotion manifests. For formal qualification, retain the exact bundle and follow TESTING.md with the existing session/editor/validator tools. Never hand-edit BUILD_INFO.json, SESSION_INFO.json or sealed evidence. A hash binds bytes; it does not prove that a WAN test occurred.
