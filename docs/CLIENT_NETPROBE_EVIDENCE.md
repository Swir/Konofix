# Client Netprobe evidence

Konofix stable-promotion evidence must prove that the exact verified Windows test bundle can authenticate the configured public Konofix Node from **both independent client networks** over direct TCP and QUIC-v1. A plain socket check, a copied screenshot, or a manually typed PASS is not sufficient.

## What this proves

`konofix-netprobe.exe` is built from the same source commit as the Windows test bundle and its byte size and SHA-256 are sealed in `BUILD_INFO.json`. Before the capture helper executes it, the helper re-hashes the binary and refuses to continue if the packaged bytes do not match that manifest.

A passing probe requires all of the following from the remote endpoint:

- a Noise-authenticated libp2p connection to the exact Peer ID recorded in `SESSION_INFO.json`;
- the exact Konofix protocol version `/konofix/4.0`;
- the expected `Konofix-Node/<version>` Identify agent;
- a successful libp2p Ping round trip;
- the exact configured direct TCP or QUIC-v1 multiaddress;
- probe provenance matching the exact source commit carried by the verified Windows bundle.

The resulting client evidence also records the test-session client ID, country and network/operator, the exact `BUILD_INFO.json` hash, the Netprobe SHA-256, bootstrap Peer ID, transport targets and the raw machine-readable probe results.

## Prepare one coherent real-network session

Create the session once from the verified Windows test bundle. The two clients must identify different endpoints, countries and networks/operators. Both bootstrap addresses must describe the same public host, port and Node Peer ID.

```powershell
.\scripts\new-network-test-session.ps1 `
  -ClientA "client-a" -ClientACountry "PL" -ClientANetwork "operator-a" `
  -ClientB "client-b" -ClientBCountry "NO" -ClientBNetwork "operator-b" `
  -TcpBootstrap  "/dns4/node.example.net/tcp/45555/p2p/<PEER_ID>" `
  -QuicBootstrap "/dns4/node.example.net/udp/45555/quic-v1/p2p/<PEER_ID>"
```

Use the real public Node hostname or globally routable IP. Reserved/example/private names and private, loopback, link-local, CGNAT, documentation or benchmark addresses are rejected by the public-host preflight.

Copy the generated session directory, including `SESSION_INFO.json`, to each tester without editing it. Each tester must use the **same verified Windows test bundle** whose `BUILD_INFO.json` created the session.

## Capture Client A evidence

On the machine recorded as Client A:

```powershell
.\scripts\capture-client-netprobe.ps1 `
  -SessionInfoPath "C:\path\to\session\SESSION_INFO.json" `
  -Client A
```

The command performs strict public-bootstrap validation, verifies the packaged Netprobe bytes, runs authenticated TCP and QUIC-v1 probes, validates the resulting JSON, and writes `client-a-netprobe.json`. Existing evidence is never silently overwritten.

## Capture Client B evidence

On the independently networked machine recorded as Client B:

```powershell
.\scripts\capture-client-netprobe.ps1 `
  -SessionInfoPath "C:\path\to\session\SESSION_INFO.json" `
  -Client B
```

Return `client-b-netprobe.json` to the same evidence directory used for the promotion check.

## Validate both clients together

```powershell
.\scripts\validate-client-netprobe.ps1 `
  -Evidence ".\test-results\client-a-netprobe.json", ".\test-results\client-b-netprobe.json" `
  -SessionInfoPath ".\test-results\SESSION_INFO.json" `
  -BuildInfoPath ".\BUILD_INFO.json" `
  -RequireBothClients
```

The validator fails closed on missing/duplicate client roles, stale evidence, wrong client metadata, mismatched build/source provenance, a modified Netprobe binary, wrong bootstrap addresses, wrong Peer ID, wrong protocol/agent, wrong transport, malformed timestamps, or incomplete probe results.

## Stable-promotion gate

The final promotion preflight now requires the two client Netprobe evidence files in addition to the five real-network scenario manifests and the public-Node soak history:

```powershell
.\scripts\check-promotion-evidence.ps1 `
  -BuildInfoPath ".\BUILD_INFO.json" `
  -SessionInfoPath ".\test-results\SESSION_INFO.json" `
  -NetworkEvidence ".\test-results\network-test-*.json" `
  -ClientNetprobeEvidence ".\test-results\client-*-netprobe.json" `
  -NodeSoakEvidence ".\test-results\soak-*.json"
```

Stable promotion requires exactly one Client A record and one Client B record, with authenticated direct TCP **and** QUIC-v1 evidence tied to the same exact build, session and public Node Peer ID.

## Important boundary

Client Netprobe evidence proves authenticated direct transport reachability and the remote Konofix protocol identity. It does **not** prove Relay use, DCUtR upgrade behavior, CGNAT traversal, chat/file-transfer correctness, or long-running Node stability. Those remain separate required real-network scenario manifests and Node-soak evidence. CI/local loopback Netprobe PASS results likewise do not count as independent-country evidence.