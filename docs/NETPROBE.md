# Konofix Netprobe

`konofix-netprobe` is a small independent libp2p client used to prove that a built Konofix Node can complete the transport and application-level handshakes expected by Konofix.

It is intentionally separate from `konofix-node`. A PASS therefore cannot come from the Node merely reporting its own listener state.

## What a PASS proves

For the supplied direct Node multiaddr, Netprobe requires all of the following before it exits successfully:

- a Noise-authenticated libp2p connection to the exact Peer ID at the end of the multiaddr;
- Identify metadata from that same Peer ID;
- protocol version exactly `/konofix/4.0`;
- an agent version exactly matching `Konofix-Node/<netprobe version>`, preventing an exact-build probe from silently accepting an older or newer Node build;
- a successful libp2p Ping round trip;
- completion before the bounded timeout.

The target grammar is fail-closed: only one host component followed by exactly TCP or UDP/QUIC-v1 and one terminal `/p2p/<PeerId>` is accepted. Relay paths, ambiguous multiple-host addresses and additional encapsulation protocols are rejected rather than being treated as direct-transport evidence.

The emitted JSON includes the selected transport, target address, expected and observed Peer IDs, Node protocol/agent metadata, RTT, elapsed time, tool version, exact source commit and timestamp.

## Windows test-bundle usage

The verified Windows test bundle contains both:

- `konofix-node.exe`
- `konofix-netprobe.exe`

For TCP:

```powershell
.\konofix-netprobe.exe --timeout 30 /dns4/node.example.org/tcp/45555/p2p/<PEER_ID>
```

For QUIC-v1:

```powershell
.\konofix-netprobe.exe --timeout 30 /dns4/node.example.org/udp/45555/quic-v1/p2p/<PEER_ID>
```

A direct address is required. Relay addresses containing `/p2p-circuit` are deliberately rejected because they would not prove the direct TCP or QUIC transport being named.

## CI/runtime smoke

`scripts/test-node-runtime.ps1` starts the production release-built Node, validates exact-build health telemetry, restarts it with the same persistent identity, then runs Netprobe against the restarted process over both loopback TCP and loopback QUIC-v1. The staged Windows bundle repeats the same smoke after provenance metadata has been generated.

Linux CI reuses the same Rust Netprobe implementation through the isolated headless Cargo target. It unit-tests and release-builds the probe without Tauri/WebKit dependencies, starts the release Node twice with one persistent identity, then requires independent authenticated TCP and QUIC-v1 Netprobe PASS evidence from the second process. The Linux smoke selects a port that is available for both TCP and UDP before launch so the QUIC gate is not weakened by a TCP-only free-port check.

These checks catch regressions where the process starts and writes a healthy JSON file but one of the real libp2p transports, authenticated identity negotiation, Identify protocol or Ping path is broken.

## Real-Internet evidence boundary

A local Netprobe PASS is a build/runtime gate, **not** the Real Internet Test milestone by itself. Stable promotion still requires the existing schema-v3 evidence from independent countries/networks through the public/community Node, including the CGNAT, relay and DCUtR scenarios and the required Node soak history.

For public testing, save the Netprobe JSON alongside the scenario evidence when it is useful, but record the promotion checks through the normal session/report tools described in `TESTING.md`. Do not replace the cross-country evidence manifests with a local or single-network probe result.
