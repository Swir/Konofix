# Konofix Global Beta

Global Beta means a public, many-computer network. A two-PC test is only the smallest smoke test and is not the beta target.

## Target topology

A Global Beta candidate should use at least three stable public/community Konofix Nodes across at least two independent providers or regions. Each Node needs a persistent Peer ID, public TCP and UDP/QUIC reachability, Circuit Relay, health telemetry and restart supervision.

Clients should eventually ship a default pool with at least two independent bootstrap identities and keep manual custom bootstrap support. One public Node is not enough because it creates a single point of failure.

## Capacity and abuse boundary

The public Node has explicit libp2p admission ceilings. Current beta defaults are:

- 1024 established connections total
- 768 established incoming connections
- 4 established connections per Peer ID
- 128 pending incoming handshakes
- 128 pending outgoing handshakes

These are safety ceilings, not a promise that every VPS can sustain those numbers. Operators must measure CPU, memory, sockets/file descriptors and bandwidth before raising limits.

## Concurrent transport admission test

The Windows beta bundle includes scripts\global-beta-load.ps1. It launches many independent exact-build konofix-netprobe.exe processes with bounded parallelism. Each successful probe still requires Noise-authenticated Peer ID, Konofix Identify metadata and a libp2p ping.

Example 50-client gate:

    .\scripts\global-beta-load.ps1 -TcpBootstrap "/dns/node.example.com/tcp/45555/p2p/PEER_ID" -QuicBootstrap "/dns/node.example.com/udp/45555/quic-v1/p2p/PEER_ID" -Clients 50 -Parallelism 10 -MinimumSuccessPercent 95 -OutputPath ".\global-beta-load-50.json"

Repeat with 100 and 250 clients before calling the infrastructure Global-Beta-ready. A load-harness PASS proves transport/admission concurrency only. It does not prove chat fan-out, room convergence, file transfer, relay, DCUtR, CGNAT behavior or long-running stability.

## Real multi-user beta gate

Before the first real Global Beta prerelease:

1. Run at least three public Nodes across at least two independent providers/regions.
2. Verify the client default bootstrap pool and failover instead of requiring every tester to paste one address manually.
3. Pass 50, 100 and 250 concurrent exact-build Netprobe admission runs without Node crash/restart.
4. Complete Rooms 2.0 production membership and count wiring.
5. Run at least 20 real clients across at least five independent networks and at least three countries for at least 60 minutes.
6. Exercise WORLD, multiple rooms, reconnect, bidirectional file transfer and SHA-256 validation.
7. Kill or isolate one public seed/relay Node and prove clients recover through the remaining pool.
8. Re-run the existing TCP, QUIC, Relay, DCUtR and CGNAT evidence gates on the exact beta candidate.
9. Publish only the exact verified build with tester handoff, rollback notes and the stable bootstrap pool.

## Infrastructure blocker

Code can prepare the fleet, limits, load tools and failover logic, but a truly global beta also requires real public hosts. GitHub Actions runners are not a substitute for long-lived inbound public bootstrap/relay infrastructure. Until at least the required public Nodes exist and real multi-user evidence passes, Global Beta remains not release-ready.
