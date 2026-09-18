#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="konofix-node"
SERVICE_USER="konofix"
PUBLIC_HOST=""
PORT="45555"
STATUS_INTERVAL="60"
BINARY_PATH="./konofix-node"
STATE_DIR="/var/lib/konofix-node"
INSTALL_DIR="/usr/local/lib/konofix-node"
ALLOW_PRIVATE=0
REQUIRE_DNS=0
DO_INSTALL=0
START_NOW=0
DO_UNINSTALL=0
PRINT_UNIT=0

usage() {
  cat <<'EOF'
Konofix public Node Linux/systemd installer

Usage:
  install-public-node-linux.sh --public-host HOST [options]
  install-public-node-linux.sh --uninstall

Options:
  --public-host HOST          Public IPv4, IPv6, or DNS name advertised by the Node.
  --port PORT                TCP and UDP/QUIC port (default: 45555; allowed: 1024-65535).
  --status-interval SEC      Node status/health interval (default: 60; minimum: 10).
  --binary PATH              Source konofix-node binary (default: ./konofix-node).
  --state-dir PATH           Persistent identity/health directory (default: /var/lib/konofix-node).
  --install-dir PATH         Staged binary directory (default: /usr/local/lib/konofix-node).
  --require-dns-resolution   Require DNS hostnames to resolve to public addresses now.
  --allow-private-address    Permit non-public IPs for controlled lab testing only.
  --print-unit               Print the validated systemd unit and exit without mutation.
  --install                  Install/update the service. Requires root.
  --start-now                Enable and start/restart after --install.
  --uninstall                Disable/remove the unit and staged binary; preserve state/identity.
  -h, --help                 Show this help.

The service runs as the unprivileged 'konofix' user, so the installer deliberately rejects
privileged ports below 1024 instead of relying on host-specific capabilities/sysctls.
State and install paths are canonicalized, must be dedicated non-top-level directories, and
must not overlap; this keeps writable Node state separated from the staged executable.
The generated systemd service also removes Linux capabilities, isolates devices/tmp/proc,
blocks namespace/realtime/kernel/clock/hostname mutation, and exposes only the dedicated
state directory as writable service storage.
The installer never edits a firewall. Public deployments must allow the selected TCP and UDP
port in the VPS/provider firewall and any host firewall before Internet testing.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --public-host) [[ $# -ge 2 ]] || fail "Missing value after --public-host."; PUBLIC_HOST="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || fail "Missing value after --port."; PORT="$2"; shift 2 ;;
    --status-interval) [[ $# -ge 2 ]] || fail "Missing value after --status-interval."; STATUS_INTERVAL="$2"; shift 2 ;;
    --binary) [[ $# -ge 2 ]] || fail "Missing value after --binary."; BINARY_PATH="$2"; shift 2 ;;
    --state-dir) [[ $# -ge 2 ]] || fail "Missing value after --state-dir."; STATE_DIR="$2"; shift 2 ;;
    --install-dir) [[ $# -ge 2 ]] || fail "Missing value after --install-dir."; INSTALL_DIR="$2"; shift 2 ;;
    --require-dns-resolution) REQUIRE_DNS=1; shift ;;
    --allow-private-address) ALLOW_PRIVATE=1; shift ;;
    --print-unit) PRINT_UNIT=1; shift ;;
    --install) DO_INSTALL=1; shift ;;
    --start-now) START_NOW=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || fail "Port must be an integer."
((PORT >= 1024 && PORT <= 65535)) || fail "Port must be between 1024 and 65535 for the unprivileged service user."
[[ "$STATUS_INTERVAL" =~ ^[0-9]+$ ]] || fail "Status interval must be an integer."
((STATUS_INTERVAL >= 10 && STATUS_INTERVAL <= 86400)) || fail "Status interval must be between 10 and 86400 seconds."
[[ "$STATE_DIR" == /* ]] || fail "State directory must be an absolute path."
[[ "$INSTALL_DIR" == /* ]] || fail "Install directory must be an absolute path."
[[ "$STATE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "State directory contains unsupported characters."
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "Install directory contains unsupported characters."
command -v realpath >/dev/null 2>&1 || fail "realpath is required for safe path validation."
STATE_DIR="$(realpath -m -- "$STATE_DIR")"
INSTALL_DIR="$(realpath -m -- "$INSTALL_DIR")"
[[ "$STATE_DIR" != "/" ]] || fail "State directory must not be the filesystem root."
[[ "$INSTALL_DIR" != "/" ]] || fail "Install directory must not be the filesystem root."
[[ "${STATE_DIR#/}" == */* ]] || fail "State directory must be a dedicated subdirectory, not a top-level system directory."
[[ "${INSTALL_DIR#/}" == */* ]] || fail "Install directory must be a dedicated subdirectory, not a top-level system directory."
[[ "$STATE_DIR" != "$INSTALL_DIR" ]] || fail "State and install directories must be different."
case "$STATE_DIR/" in
  "$INSTALL_DIR/"*) fail "State directory must not be inside the install directory." ;;
esac
case "$INSTALL_DIR/" in
  "$STATE_DIR/"*) fail "Install directory must not be inside the state directory." ;;
esac
((START_NOW == 0 || DO_INSTALL == 1)) || fail "--start-now requires --install."
((DO_UNINSTALL == 0 || DO_INSTALL == 0)) || fail "--install and --uninstall are mutually exclusive."

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
INSTALLED_BINARY="${INSTALL_DIR}/konofix-node"
IDENTITY_FILE="${STATE_DIR}/node-identity.key"
HEALTH_FILE="${STATE_DIR}/node-health.json"

if ((DO_UNINSTALL)); then
  [[ $EUID -eq 0 ]] || fail "--uninstall requires root."
  command -v systemctl >/dev/null 2>&1 || fail "systemctl is required for --uninstall."
  systemctl disable --now "${SERVICE_NAME}.service" >/dev/null 2>&1 || true
  rm -f -- "$UNIT_PATH" "$INSTALLED_BINARY"
  systemctl daemon-reload
  printf 'Removed %s service and staged binary. Persistent state was preserved at %s\n' "$SERVICE_NAME" "$STATE_DIR"
  exit 0
fi

[[ -n "$PUBLIC_HOST" ]] || fail "--public-host is required."
command -v python3 >/dev/null 2>&1 || fail "python3 is required for public-host validation."

python3 - "$PUBLIC_HOST" "$ALLOW_PRIVATE" "$REQUIRE_DNS" <<'PY' || exit $?
import ipaddress
import re
import socket
import sys

raw = sys.argv[1].strip()
allow_private = sys.argv[2] == "1"
require_dns = sys.argv[3] == "1"
host = raw[1:-1] if raw.startswith("[") and raw.endswith("]") else raw
if not host or "/" in host or any(ch.isspace() for ch in host):
    print(f"ERROR: invalid public host: {raw}", file=sys.stderr)
    raise SystemExit(2)

blocked_v4 = tuple(ipaddress.ip_network(value) for value in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
    "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
    "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
))
public_v6 = ipaddress.ip_network("2000::/3")
blocked_v6 = tuple(ipaddress.ip_network(value) for value in (
    "2001:2::/48", "2001:db8::/32", "2001:10::/28", "2001:20::/28",
))

def is_public_evidence_address(ip: ipaddress._BaseAddress) -> bool:
    if isinstance(ip, ipaddress.IPv4Address):
        return not any(ip in network for network in blocked_v4)
    if ip.ipv4_mapped is not None:
        return is_public_evidence_address(ip.ipv4_mapped)
    if ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_multicast:
        return False
    return ip in public_v6 and not any(ip in network for network in blocked_v6)

def require_global(address: str) -> None:
    ip = ipaddress.ip_address(address)
    if not allow_private and not is_public_evidence_address(ip):
        print(f"ERROR: address is not globally routable under the Konofix evidence policy: {ip}", file=sys.stderr)
        raise SystemExit(3)

try:
    require_global(host)
except ValueError:
    lower = host.rstrip(".").lower()
    if len(lower) > 253 or "." not in lower or not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", lower):
        print(f"ERROR: invalid public DNS name: {host}", file=sys.stderr)
        raise SystemExit(4)
    reserved_suffixes = (
        "localhost", "local", "invalid", "test", "example",
        "example.com", "example.net", "example.org",
        "onion", "alt", "arpa", "internal",
    )
    if any(lower == suffix or lower.endswith("." + suffix) for suffix in reserved_suffixes):
        print(f"ERROR: reserved/non-public DNS name: {host}", file=sys.stderr)
        raise SystemExit(5)
    if require_dns:
        try:
            addresses = sorted({item[4][0] for item in socket.getaddrinfo(lower, None, type=socket.SOCK_STREAM)})
        except OSError as exc:
            print(f"ERROR: DNS resolution failed for {host}: {exc}", file=sys.stderr)
            raise SystemExit(6)
        if not addresses:
            print(f"ERROR: DNS returned no addresses for {host}", file=sys.stderr)
            raise SystemExit(7)
        for address in addresses:
            require_global(address)
PY

[[ -f "$BINARY_PATH" ]] || fail "Node binary not found: $BINARY_PATH"
[[ -x "$BINARY_PATH" ]] || fail "Node binary is not executable: $BINARY_PATH"
if ! "$BINARY_PATH" --help 2>&1 | grep -q 'Konofix Node'; then
  fail "Binary does not identify itself as Konofix Node: $BINARY_PATH"
fi

NODE_LAB_FLAG=""
if ((ALLOW_PRIVATE)); then
  NODE_LAB_FLAG=" --allow-private-address"
fi

render_unit() {
  cat <<EOF
[Unit]
Description=Konofix public P2P bootstrap/relay Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${INSTALLED_BINARY} --port ${PORT} --public-host ${PUBLIC_HOST} --status-interval ${STATUS_INTERVAL} --health-file ${HEALTH_FILE} --identity-file ${IDENTITY_FILE}${NODE_LAB_FLAG}
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectHostname=true
ProtectClock=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true
SystemCallArchitectures=native
KeyringMode=private
RemoveIPC=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
EOF
}

printf '=== Konofix Linux public Node preflight ===\n'
printf 'Public host:     %s\n' "$PUBLIC_HOST"
printf 'TCP/UDP port:    %s\n' "$PORT"
printf 'Source binary:   %s\n' "$BINARY_PATH"
printf 'Installed binary:%s\n' "$INSTALLED_BINARY"
printf 'State directory: %s\n' "$STATE_DIR"
printf 'Identity file:   %s\n' "$IDENTITY_FILE"
printf 'Health file:     %s\n' "$HEALTH_FILE"
printf 'Firewall:        NOT modified; allow TCP and UDP %s separately.\n' "$PORT"

if ((PRINT_UNIT)); then
  render_unit
  exit 0
fi

if ((DO_INSTALL == 0)); then
  printf '\nValidated systemd unit preview:\n'
  render_unit
  printf '\nNo system changes were made. Re-run with --install after reviewing the configuration.\n'
  exit 0
fi

[[ $EUID -eq 0 ]] || fail "--install requires root."
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required for --install."
command -v useradd >/dev/null 2>&1 || fail "useradd is required for --install."

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$BINARY_PATH" "$INSTALLED_BINARY"
unit_tmp="$(mktemp)"
trap 'rm -f -- "$unit_tmp"' EXIT
render_unit >"$unit_tmp"
install -m 0644 "$unit_tmp" "$UNIT_PATH"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null
if ((START_NOW)); then
  systemctl restart "${SERVICE_NAME}.service"
fi
printf 'Installed %s. Persistent identity/state: %s\n' "$UNIT_PATH" "$STATE_DIR"
printf 'Remember to allow inbound TCP and UDP %s in provider/host firewalls.\n' "$PORT"
