param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$Commit,

  [Parameter(Mandatory = $true)]
  [string]$WorkflowRun
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version) -or $Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
  throw "Tester handoff version is not a safe SemVer-like value: '$Version'"
}
if ($Commit -cnotmatch '^[0-9a-f]{40}$') {
  throw "Tester handoff commit must be an exact lowercase 40-character Git SHA: '$Commit'"
}
if ($WorkflowRun -cnotmatch '^[0-9]+$') {
  throw "Tester handoff workflow run must be a decimal GitHub Actions run ID: '$WorkflowRun'"
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  throw 'Tester handoff output path is empty.'
}

$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent)) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

$handoff = @"
<!-- KONOFIX-TESTER-HANDOFF-BUILD:v1 -->
# Konofix Chat — Exact-Build Public-Network Test Handoff

This file was generated for one exact Windows test bundle. It is **test evidence only, not a published GitHub Release**.

- Product: Konofix Chat
- Build version: $Version
- Source commit: $Commit
- Workflow run: $WorkflowRun
- Evidence scope: exact-build public-network testing

BUILD_INFO.json is the authoritative sealed inventory for this bundle. Keep this bundle, its checksum, the generated network-test session and every evidence file together. Never mix binaries, scripts or evidence from a different source commit, workflow artifact or historical prerelease.

## Start a participant-operated network

1. Install the same application build on each Windows computer and connect with different nicknames. Every connected app is already a P2P node; do not install a separate server just to chat.
2. On one LAN, wait for automatic peer discovery and test WORLD, room creation/switching, counts, file acceptance/SHA-256 and reconnect.
3. For first contact across the Internet, an online participant opens Network settings, copies a reachable address and shares it with another participant, who adds it in Network settings. Private LAN addresses work only on that LAN. NAT/CGNAT may require a reachable participant acting as relay or suitable port mapping.
4. Keep at least three participants online, establish more than one contact path, then close one participant and verify that the others still exchange messages, rooms and files. Learned peer addresses help later reconnection; if every participant leaves, fresh invitations may be needed.
5. Record actual outcomes and the exact build identity above. Local/CI success does not prove real multi-country reachability or the 20-client soak gate. See GLOBAL_BETA.md and TESTING.md in this bundle.

## Optional headless-Node qualification flow

The separately packaged Node is an optional always-on participant. These tools qualify that deployment profile; they do not replace participant-application testing or require a central chat server.

1. Verify the outer ZIP SHA-256 before extraction and keep the checksum beside the exact archive.
2. Confirm BUILD_INFO.json identifies the expected version and source commit; use only the packaged konofix-node.exe, konofix-netprobe.exe and bundled scripts from this artifact.
3. Deploy or launch the public Konofix Node with the bundled scripts\public-node.ps1 (or the supervised startup-task installer), preserve its identity and pass public-node readiness checks.
4. Collect and validate a continuous exact-build Node soak history with scripts\collect-node-soak.ps1 and scripts\validate-node-soak.ps1.
5. Create one coherent test workspace with scripts\new-network-test-session.ps1 using independently identified Client A and Client B countries/networks plus one paired TCP/QUIC bootstrap identity.
6. On both Windows clients, capture authenticated direct TCP and QUIC-v1 evidence with scripts\capture-client-netprobe.ps1; do not reuse one host or default-route network as both clients.
7. Record TCP, QUIC, Relay, DCUtR and CGNAT/application observations with scripts\set-network-test-result.ps1. Every PASS needs concrete evidence; file-transfer PASS checks need the observed full SHA-256 digest.
8. Validate the session/manifests and run scripts\check-promotion-evidence.ps1. Only one coherent exact-build evidence set may support promotion.

Full command details and scenario requirements are in TESTING.md, NODE.md and NODE_SOAK.md in this bundle.

## Safety and interpretation

- Never publish node-identity.key or any other private service state.
- A successful TCP socket reachability check is not proof of QUIC; use the real Netprobe/transport evidence required by the gate.
- Do not hand-edit sealed evidence or SESSION_INFO.json; use the bundled editor/session tools so hashes and inventory stay synchronized.
- The historical v0.4.2-test1 prerelease is a separate published preview. Its archive or historical notes must not be used as the identity of this exact-build test bundle.
- Green CI and this handoff do not make the Real Internet Test milestone complete. The remaining roadmap gates require real independent public-network evidence.

---

**Konofix Chat — by Swir**
"@

[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($OutputPath),
  $handoff.Replace("`r`n", "`n"),
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Exact-build tester handoff written: $OutputPath" -ForegroundColor Green
