# Konofix Node 0.4.2

`konofix-node` is a lightweight community infrastructure node. It is not an account server and it does not store chat history.

## Features

- Kademlia DHT server
- bootstrap peer
- AutoNAT peer
- Circuit Relay v2 server
- GossipSub router for `#WORLD`
- TCP + QUIC
- persistent Peer ID across restarts
- explicit identity-file location for service/VPS deployments
- fail-closed identity loading: an unreadable or corrupted existing key is never silently replaced
- automatic generation of ready-to-use public multiaddresses
- fail-closed validation of non-global IPv4/IPv6 `--public-host` literals in the raw Node binary, with an explicit lab-only override
- periodic operational status lines with uptime and connected-peer count
- optional metadata-only JSON health snapshot for supervisors and monitoring
- exact source-commit provenance embedded into Node health snapshots
- IPv4, IPv6, and generic DNS bootstrap address generation
- fail-closed Windows deployment preflight with deterministic JSON output for automation
- preview-first Windows startup-task installer with protected SYSTEM-only runtime/state, restart policy and optional scoped firewall rules

## Windows

Run `build-node.bat`, then start from the source tree, or use the `konofix-node.exe` included in a verified Windows test archive.

### Recommended public deployment preflight

The extracted Windows test archive includes `scripts\public-node.ps1`. Run it before exposing a Node. It validates the host and state paths without starting the process:

```powershell
.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -RequireDnsResolution
```

Then launch the same validated configuration:

```powershell
.\scripts\public-node.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\Konofix `
  -Start
```

The preflight rejects non-globally-routable literals, including private, loopback, link-local, CGNAT, documentation, benchmark, deprecated relay-anycast, reserved and other special-use ranges. Public DNS input must be a public-looking FQDN; special/private-use namespaces such as `localhost`, `.local`, `.test`, `.example`, `example.com`, `example.net`, `example.org`, `.onion`, `.alt`, `.arpa`, and `.internal` are rejected. When DNS resolution is required (and before `-Start`), every returned address must satisfy the same globally-routable policy instead of accepting a mixed public/private answer set. The preflight also refuses identity/health path collisions and pins an explicit persistent identity path. `-AllowPrivateAddress` exists only for controlled LAN/lab tests. Use `-AsJson` to obtain normalized launch metadata and bootstrap address templates without starting the Node.

### Supervised startup task

For a public/community Node that should survive user logoff and Windows reboot, use `scripts\install-public-node-task.ps1` from the verified Windows archive. The script reuses the same public-host preflight and defaults persistent state to `%ProgramData%\Konofix Node` when no state directory is supplied.

Start with a mutation-free preview:

```powershell
.\scripts\install-public-node-task.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\ProgramData\KonofixNode `
  -RequireDnsResolution `
  -ConfigureFirewall
```

The preview prints the normalized public host, persistent identity/health paths, staged runtime paths, SYSTEM task identity, restart policy, planned storage security policy, and whether the scoped firewall rules would be managed. `-AsJson` returns the same plan in deterministic machine-readable form.

The supervised SYSTEM path deliberately has stricter storage rules than an interactive launch. `IdentityFile` and `HealthFile` must remain inside the dedicated `StateDirectory`; installation rejects an existing state/service path that traverses a Windows reparse point; the protected state and staged `service` directory disable inherited write access and grant full control only to `SYSTEM` and the built-in Administrators group. The staged Node and launcher receive the same protected access policy, as do existing identity/health files. This prevents an ordinary user from replacing a script or executable that Task Scheduler will later execute as SYSTEM, and protects the persistent Peer-ID key from non-admin modification. Use a dedicated ProgramData subtree rather than a user-writable folder.

Install or update the task from an elevated PowerShell window only after reviewing the preview:

```powershell
.\scripts\install-public-node-task.ps1 `
  -PublicHost node.yourdomain.com `
  -StateDirectory C:\ProgramData\KonofixNode `
  -RequireDnsResolution `
  -ConfigureFirewall `
  -Install `
  -StartNow
```

Before mutating the task, installation verifies that required ScheduledTasks cmdlets, the source Node, and (when requested) firewall cmdlets are available. If an existing task is running, the installer stops it and waits for the process/task state to leave `Running` before replacing the protected runtime files; a previously running task is restarted after the secured update. Installation copies only `konofix-node.exe` and the validated `public-node.ps1` launcher into the persistent `service` subdirectory, registers a SYSTEM startup task, enables restart attempts with a one-minute interval, and optionally creates inbound TCP and UDP firewall rules scoped to the staged Node executable and configured port. The task command is encoded after all user-controlled values are PowerShell-literal quoted, avoiding fragile nested quoting in Task Scheduler arguments.

To remove the task:

```powershell
.\scripts\install-public-node-task.ps1 -Uninstall
```

Uninstall removes the configured startup task and the dedicated `Konofix Public Node` firewall group. It deliberately does **not** delete the state directory, health history or identity key. Keeping the identity prevents an accidental public bootstrap Peer-ID rotation. Delete persistent state only as a separate, deliberate administrator action after it is no longer needed.

The raw binary remains available for manual operation:

```powershell
src-tauri\target\release\konofix-node.exe --port 45555 --public-host YOUR_PUBLIC_IP
```

The raw binary now fails closed when `--public-host` is a non-global IP literal, before identity creation, listeners, or shareable-address output. The literal policy mirrors the deployment preflight for private, loopback, link-local, CGNAT, documentation, benchmarking, multicast/reserved and corresponding IPv6 special-use ranges. `--allow-private-address` is available only for controlled lab testing; when used, the Node labels the generated addresses **LAB-ONLY** and explicitly marks them invalid for public-node/cross-country promotion evidence. DNS names remain accepted by the binary because syntax alone does not prove reachability; use the deployment/readiness tooling when DNS resolution itself must be verified.

A public DNS name is also supported:

```powershell
konofix-node.exe --port 45555 --public-host node.yourdomain.com
```

### Stable public identity

A public/community Node should use an explicit identity path on persistent storage. The Peer ID is derived from this key, so preserving the file preserves bootstrap identity across service restarts and redeployments:

```powershell
konofix-node.exe `
  --port 45555 `
  --public-host node.yourdomain.com `
  --identity-file C:\Konofix\node-identity.key `
  --health-file C:\Konofix\health.json
```

If `--identity-file` is omitted, Konofix keeps the compatibility default `%LOCALAPPDATA%\Konofix Chat\node-identity.key`. The Node prints the identity path it actually uses at startup.

Identity handling is deliberately fail-closed. If an existing identity file cannot be read or decoded, startup stops with an error instead of generating a replacement key. This prevents a damaged file, permission problem, or operator mistake from silently changing the public Node Peer ID and invalidating bootstrap/soak evidence. Back up the identity file and protect it as service state; do not publish or share its contents.

The default status interval is 60 seconds. It can be changed to any value of 10 seconds or more:

```powershell
konofix-node.exe --port 45555 --public-host node.yourdomain.com --status-interval 30
```

Status output is intentionally metadata-only:

```text
STATUS uptime=3600s connected_peers=8 peer_id=12D3KooW...
```

It does not include chat messages, room contents, filenames, or transferred data.

For service supervision or a monitoring agent, enable a JSON health snapshot:

```powershell
konofix-node.exe --port 45555 --public-host node.yourdomain.com --status-interval 30 --health-file C:\Konofix\health.json
```

The file is refreshed on every status interval and contains only operational metadata:

```json
{
  "schema": 2,
  "status": "running",
  "version": "0.4.2",
  "source_commit": "0123456789abcdef0123456789abcdef01234567",
  "peer_id": "12D3KooW...",
  "uptime_seconds": 3600,
  "connected_peers": 8,
  "timestamp_unix": 1789430400
}
```

CI/repository builds embed the exact 40-character source commit used to produce the Node. A local source tree without usable Git metadata may report `source_commit` as `unknown`; that is accepted for ordinary local health monitoring but cannot satisfy a stable-promotion commit pin.

On a clean Ctrl+C shutdown, `status` is changed to `stopped`. Monitoring should treat an old `timestamp_unix` as a stale or unhealthy process. The snapshot is written through a temporary file before replacement so readers do not normally observe partially written JSON.

Konofix includes a strict health validator suitable for Task Scheduler, a VPS supervisor, or an external monitoring job:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\check-node-health.ps1 -Path "C:\Konofix\health.json" -MaxAgeSeconds 90
```

For release/evidence collection, pin the exact Node binary as well as its version and Peer ID:

```powershell
.\scripts\check-node-health.ps1 `
  -Path "C:\Konofix\health.json" `
  -ExpectedVersion '0.4.2' `
  -ExpectedPeerId '12D3KooW...' `
  -ExpectedSourceCommit '0123456789abcdef0123456789abcdef01234567' `
  -RequirePeer
```

The validator rejects missing or malformed snapshots, unsupported schemas, non-running state, empty Peer IDs, malformed source commits, stale timestamps, timestamps unexpectedly far in the future, and invalid peer counts. Add `-RequirePeer` during an active cross-country test when at least one connected peer is expected. A non-zero exit status means the check failed, which makes the script suitable for automated monitoring.

Open/forward these ports in the router and firewall:

- TCP 45555
- UDP 45555

Do not replace or delete the configured identity file if the bootstrap address should remain stable. Deleting a missing/default identity is the only situation in which the Node intentionally creates a new Peer ID; an existing malformed identity fails startup instead of being overwritten.

## Ready bootstrap address

When `--public-host` is provided, the Node prints entries such as:

```text
BOOTSTRAP TCP : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
BOOTSTRAP QUIC: /ip4/203.0.113.10/udp/45555/quic-v1/p2p/12D3KooW...
RECOMMENDED   : /ip4/203.0.113.10/tcp/45555/p2p/12D3KooW...
```

The values above use an IANA documentation address only to illustrate multiaddr syntax; the production deployment/readiness tools deliberately reject it as public evidence.

For DNS names, the Node uses the generic `/dns/...` multiaddr form so the hostname is not artificially restricted to IPv4-only resolution.

Paste the `RECOMMENDED` address into **Network settings → Bootstrap**. The client stores it locally.

Addresses such as `0.0.0.0`, `127.0.0.1`, `::`, private IPv4 addresses, IPv6 unique-local/link-local addresses, CGNAT, documentation, benchmarking, multicast/reserved and other special-use ranges are not global bootstrap addresses. The raw Node binary now rejects those IP literals by default instead of merely warning. `--allow-private-address` is restricted to controlled lab testing and produces LAB-ONLY output that is not valid promotion evidence. The deployment/readiness tooling remains stricter for DNS because it can resolve the name and validate every returned address.

A public IP or DNS name plus reachable TCP and UDP ports are required for a proper Internet test.

## VPS

A small VPS only needs one Konofix Node process. The long-term goal is to run several independent nodes across different countries and providers so one outage cannot disconnect the entire network.

For a public test node, keep the process supervised by the operating system or a service manager, place `--identity-file` on persistent protected storage, back that file up securely, monitor the periodic status line or JSON health snapshot, and verify both TCP and UDP/QUIC reachability from an external network. On Windows, the bundled startup-task installer provides a reproducible supervised path without requiring a source checkout or an interactive user session.

A basic health check can verify that:

1. `status` is `running`,
2. `timestamp_unix` is newer than roughly two configured status intervals,
3. the expected `peer_id` remains unchanged across restarts,
4. `source_commit` matches the exact Windows artifact being tested.

`connected_peers` is telemetry, not a standalone health requirement; a healthy node can legitimately have zero peers during quiet periods. During a controlled test, `check-node-health.ps1 -RequirePeer` turns that telemetry into a temporary test assertion.

## Privacy

The Node does not save chat history or files. File transfer uses request/response between peers and can traverse an encrypted relay transport when direct connectivity is impossible. `#WORLD` is a public GossipSub topic. The health snapshot contains operational metadata only.
