# Konofix Node on Linux VPS

This guide covers the headless **Konofix Node** on Linux x86_64. The desktop chat application remains a Windows target; the server binary is intentionally built without Tauri/WebKit/GUI runtime dependencies.

## Verified build model

`Linux Node CI` builds the production Node implementation through the dedicated `node-linux/Cargo.toml` target. That manifest intentionally has no desktop library target, so Linux never needs to compile the Windows/Tauri application just to produce the server. `node-linux/src/main.rs` includes the canonical implementation from `src-tauri/src/bin/konofix-node.rs`, keeping the runtime single-sourced instead of maintaining a Linux fork.

The isolated manifest is guarded against dependency drift: CI compares its package version, Rust version and shared dependency tables with `src-tauri/Cargo.toml`, copies the committed `src-tauri/Cargo.lock`, and then requires `cargo metadata --locked`, tests and the release build to succeed. A dependency gate separately fails if the Linux graph pulls in `tauri`, `tauri-build`, or `rfd`.

The CI runtime smoke test does more than call `--help`. It launches the release binary, waits for a schema-v2 health snapshot, verifies version and exact embedded source commit, stops the process cleanly, restarts it with the same identity file, and requires the Peer ID to remain unchanged. The systemd installer has its own mutation-free self-tests as a separate gate.

A successful `main` run uploads a Linux x86_64 bundle containing:

- `konofix-node`,
- `scripts/install-public-node-linux.sh`,
- Node, soak, and Linux operator documentation,
- `NODE_BUILD_INFO.json` with exact source commit, version, binary size and SHA-256,
- a `.tar.gz` archive and SHA-256 checksum.

The Linux bundle is public-Node infrastructure. It is not the Windows chat client and is not, by itself, proof that real cross-country/CGNAT promotion gates passed.

## Network requirements

A public Node needs a globally reachable IP address or DNS name and the same port reachable over both transports:

- TCP 45555 — libp2p TCP,
- UDP 45555 — QUIC-v1.

The installer never modifies a firewall. Allow the selected TCP and UDP port in the VPS/provider firewall and, when present, the host firewall. Do not claim QUIC success merely because UDP is allowed; the real QUIC scenario still has to pass the Konofix/libp2p test campaign.

## Preview the service first

Extract the verified Linux bundle, then run the installer without `--install`:

```bash
bash scripts/install-public-node-linux.sh \
  --public-host node.yourdomain.com \
  --binary ./konofix-node \
  --require-dns-resolution
```

Preview mode performs validation and prints the exact systemd unit without changing the system. It validates:

- the selected binary exists, is executable and identifies itself as Konofix Node,
- the port and status interval are in supported ranges,
- state/install directories are separate absolute paths with safe characters,
- literal IP addresses are globally routable unless the explicit lab override is used,
- DNS names use public-looking fully qualified syntax,
- `--require-dns-resolution` resolves the DNS name and rejects non-global answers.

Private/CGNAT/documentation IPs are rejected by default. `--allow-private-address` exists only for controlled lab testing and must not be used as public-network evidence.

To print only the generated unit:

```bash
bash scripts/install-public-node-linux.sh \
  --public-host node.yourdomain.com \
  --binary ./konofix-node \
  --print-unit
```

## Install as a hardened systemd service

After reviewing the preview, run as root:

```bash
sudo bash scripts/install-public-node-linux.sh \
  --public-host node.yourdomain.com \
  --binary ./konofix-node \
  --require-dns-resolution \
  --install \
  --start-now
```

Defaults:

- service: `konofix-node.service`,
- service user/group: `konofix`,
- staged binary: `/usr/local/lib/konofix-node/konofix-node`,
- persistent state: `/var/lib/konofix-node`,
- identity: `/var/lib/konofix-node/node-identity.key`,
- health snapshot: `/var/lib/konofix-node/node-health.json`,
- TCP/UDP port: `45555`,
- status interval: `60` seconds.

The generated service uses a dedicated unprivileged system user and includes hardening such as `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, kernel/control-group protections, a narrow writable state path and restricted address families. It restarts on process failure and preserves identity/state across service restarts and binary updates.

Check service state and logs:

```bash
sudo systemctl status konofix-node.service
sudo journalctl -u konofix-node.service -f
```

The Node should print one stable Peer ID and TCP/QUIC bootstrap multiaddresses for the configured public host.

## Identity and health evidence

Never delete or replace `node-identity.key` during a promotion campaign. The Node deliberately fails closed if an existing identity cannot be read/decoded rather than silently rotating its Peer ID.

The health file contains metadata only:

```bash
sudo cat /var/lib/konofix-node/node-health.json
```

It includes Node version, exact source commit, Peer ID, uptime, connected peer count and timestamp. Use that same health stream for soak evidence. Stable promotion still requires the exact-build session, all five real-network scenario reports and continuous soak validation; running a Linux service does not automatically mark the public-Node roadmap gate complete.

## Updating the binary

Do not overwrite a running binary blindly. Keep the state directory unchanged and preserve the identity file:

```bash
sudo systemctl stop konofix-node.service
sudo install -m 0755 ./konofix-node /usr/local/lib/konofix-node/konofix-node
sudo systemctl start konofix-node.service
```

For release/promotion testing, start a new evidence session after changing the Node build/source commit. Evidence from one exact source commit must not promote another build.

## Uninstall

```bash
sudo bash scripts/install-public-node-linux.sh --uninstall
```

Uninstall disables/removes the systemd unit and staged binary, then reloads systemd. It intentionally preserves `/var/lib/konofix-node`, including the identity key and health history. Remove persistent state only as a separate deliberate operator action after the Peer ID is no longer needed.

## Controlled lab mode

For a private test environment only:

```bash
bash scripts/install-public-node-linux.sh \
  --public-host 10.0.0.5 \
  --allow-private-address \
  --binary ./konofix-node \
  --print-unit
```

This is not public-Node or cross-country evidence. Stable promotion requires a genuinely public path and independent real networks.
