#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALLER="$ROOT/scripts/install-public-node-linux.sh"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
FAKE_NODE="$TMP/konofix-node"

cat >"$FAKE_NODE" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "--help" ]]; then
  echo "Konofix Node 0.4.2"
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_NODE"

fail() {
  printf 'TEST ERROR: %s\n' "$*" >&2
  exit 1
}

expect_reject() {
  local name="$1"
  shift
  if bash "$INSTALLER" "$@" >/dev/null 2>&1; then
    fail "Expected rejection: $name"
  fi
  printf 'Expected rejection passed: %s\n' "$name"
}

unit="$(bash "$INSTALLER" \
  --public-host 1.1.1.1 \
  --binary "$FAKE_NODE" \
  --state-dir /var/lib/konofix-selftest \
  --install-dir /usr/local/lib/konofix-selftest \
  --port 45555 \
  --status-interval 60 \
  --print-unit)"

for expected in \
  'User=konofix' \
  'Group=konofix' \
  'Restart=on-failure' \
  'NoNewPrivileges=true' \
  'CapabilityBoundingSet=' \
  'AmbientCapabilities=' \
  'PrivateTmp=true' \
  'PrivateDevices=true' \
  'ProtectSystem=strict' \
  'ProtectHome=true' \
  'ProtectHostname=true' \
  'ProtectClock=true' \
  'ProtectKernelTunables=true' \
  'ProtectKernelModules=true' \
  'ProtectKernelLogs=true' \
  'ProtectControlGroups=true' \
  'ProtectProc=invisible' \
  'ProcSubset=pid' \
  'RestrictNamespaces=true' \
  'RestrictRealtime=true' \
  'RestrictSUIDSGID=true' \
  'LockPersonality=true' \
  'MemoryDenyWriteExecute=true' \
  'SystemCallArchitectures=native' \
  'KeyringMode=private' \
  'RemoveIPC=true' \
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' \
  'ReadWritePaths=/var/lib/konofix-selftest' \
  '--public-host 1.1.1.1' \
  '--identity-file /var/lib/konofix-selftest/node-identity.key' \
  '--health-file /var/lib/konofix-selftest/node-health.json'; do
  grep -Fq -- "$expected" <<<"$unit" || fail "Generated unit is missing: $expected"
done
if grep -Fq -- '--allow-private-address' <<<"$unit"; then
  fail 'Public systemd unit must not enable the lab-only raw Node override.'
fi

# The public service must not regain ambient/bounding capabilities or a second writable tree.
[[ "$(grep -Fxc 'CapabilityBoundingSet=' <<<"$unit")" -eq 1 ]] || fail 'CapabilityBoundingSet must be explicitly empty exactly once.'
[[ "$(grep -Fxc 'AmbientCapabilities=' <<<"$unit")" -eq 1 ]] || fail 'AmbientCapabilities must be explicitly empty exactly once.'
[[ "$(grep -Fc 'ReadWritePaths=' <<<"$unit")" -eq 1 ]] || fail 'Exactly one writable service path is expected.'
if grep -Eq '^ReadWritePaths=.*(/usr|/etc|/home)(/|$)' <<<"$unit"; then
  fail 'System/application paths must not be writable through ReadWritePaths.'
fi

preview="$(bash "$INSTALLER" \
  --public-host 1.0.0.1 \
  --binary "$FAKE_NODE" \
  --state-dir /var/lib/konofix-preview \
  --install-dir /usr/local/lib/konofix-preview)"
grep -Fq 'No system changes were made.' <<<"$preview" || fail 'Preview mode must be mutation-free.'
grep -Fq 'Firewall:        NOT modified' <<<"$preview" || fail 'Preview must state that firewall mutation is not performed.'

lab_unit="$(bash "$INSTALLER" \
  --public-host 10.0.0.5 \
  --allow-private-address \
  --binary "$FAKE_NODE" \
  --state-dir /var/lib/konofix-lab \
  --install-dir /usr/local/lib/konofix-lab \
  --print-unit)"
grep -Fq -- '--public-host 10.0.0.5' <<<"$lab_unit" || fail 'Lab override did not preserve private host.'
grep -Fq -- '--allow-private-address' <<<"$lab_unit" || fail 'Lab systemd unit must forward the raw Node lab-only override.'

boundary_unit="$(bash "$INSTALLER" \
  --public-host 1.1.1.1 \
  --port 1024 \
  --binary "$FAKE_NODE" \
  --state-dir /var/lib/konofix-port-boundary \
  --install-dir /usr/local/lib/konofix-port-boundary \
  --print-unit)"
grep -Fq -- '--port 1024' <<<"$boundary_unit" || fail 'Lowest supported unprivileged port was not preserved.'

canonical_unit="$(bash "$INSTALLER" \
  --public-host 1.1.1.1 \
  --binary "$FAKE_NODE" \
  --state-dir /var/lib/konofix-path/../konofix-canonical-state \
  --install-dir /usr/local/lib/konofix-path/../konofix-canonical-bin \
  --print-unit)"
grep -Fq 'ReadWritePaths=/var/lib/konofix-canonical-state' <<<"$canonical_unit" || fail 'State path was not canonicalized.'
grep -Fq 'ExecStart=/usr/local/lib/konofix-canonical-bin/konofix-node' <<<"$canonical_unit" || fail 'Install path was not canonicalized.'
if grep -Fq '/..' <<<"$canonical_unit"; then
  fail 'Generated unit must not retain parent-directory aliases.'
fi

mkdir -p "$TMP/alias-target"
ln -s "$TMP/alias-target" "$TMP/state-link"

expect_reject 'private address without lab override' \
  --public-host 10.0.0.5 --binary "$FAKE_NODE" --state-dir /var/lib/k1 --install-dir /usr/local/lib/k1 --print-unit
expect_reject 'CGNAT address without lab override' \
  --public-host 100.64.0.1 --binary "$FAKE_NODE" --state-dir /var/lib/k2 --install-dir /usr/local/lib/k2 --print-unit
expect_reject 'protocol-assignment address without lab override' \
  --public-host 192.0.0.8 --binary "$FAKE_NODE" --state-dir /var/lib/k2a --install-dir /usr/local/lib/k2a --print-unit
expect_reject 'documentation address without lab override' \
  --public-host 203.0.113.10 --binary "$FAKE_NODE" --state-dir /var/lib/k3 --install-dir /usr/local/lib/k3 --print-unit
expect_reject 'deprecated relay-anycast address without lab override' \
  --public-host 192.88.99.1 --binary "$FAKE_NODE" --state-dir /var/lib/k3a --install-dir /usr/local/lib/k3a --print-unit
expect_reject 'benchmark address without lab override' \
  --public-host 198.18.0.1 --binary "$FAKE_NODE" --state-dir /var/lib/k3b --install-dir /usr/local/lib/k3b --print-unit
expect_reject 'reserved high IPv4 address without lab override' \
  --public-host 240.0.0.1 --binary "$FAKE_NODE" --state-dir /var/lib/k3c --install-dir /usr/local/lib/k3c --print-unit
expect_reject 'documentation IPv6 without lab override' \
  --public-host 2001:db8::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3d --install-dir /usr/local/lib/k3d --print-unit
expect_reject 'benchmark IPv6 without lab override' \
  --public-host 2001:2::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3e --install-dir /usr/local/lib/k3e --print-unit
expect_reject 'ORCHIDv1 IPv6 without lab override' \
  --public-host 2001:10::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3f --install-dir /usr/local/lib/k3f --print-unit
expect_reject 'ORCHIDv2 IPv6 without lab override' \
  --public-host 2001:20::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3g --install-dir /usr/local/lib/k3g --print-unit
expect_reject 'RFC 9637 documentation IPv6 without lab override' \
  --public-host 3fff::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3g2 --install-dir /usr/local/lib/k3g2 --print-unit
expect_reject 'ULA IPv6 without lab override' \
  --public-host fd00::1 --binary "$FAKE_NODE" --state-dir /var/lib/k3h --install-dir /usr/local/lib/k3h --print-unit
expect_reject 'reserved DNS suffix' \
  --public-host node.example --binary "$FAKE_NODE" --state-dir /var/lib/k4 --install-dir /usr/local/lib/k4 --print-unit
expect_reject 'IANA example.com documentation namespace' \
  --public-host node.example.com --binary "$FAKE_NODE" --state-dir /var/lib/k4a --install-dir /usr/local/lib/k4a --print-unit
expect_reject 'IANA example.net documentation namespace' \
  --public-host node.example.net --binary "$FAKE_NODE" --state-dir /var/lib/k4a2 --install-dir /usr/local/lib/k4a2 --print-unit
expect_reject 'IANA example.org documentation namespace' \
  --public-host node.example.org --binary "$FAKE_NODE" --state-dir /var/lib/k4a3 --install-dir /usr/local/lib/k4a3 --print-unit
expect_reject 'private internal namespace' \
  --public-host bootstrap.internal --binary "$FAKE_NODE" --state-dir /var/lib/k4b --install-dir /usr/local/lib/k4b --print-unit
expect_reject 'onion special-use namespace' \
  --public-host relay.onion --binary "$FAKE_NODE" --state-dir /var/lib/k4c --install-dir /usr/local/lib/k4c --print-unit
expect_reject 'home.arpa special-use namespace' \
  --public-host router.home.arpa --binary "$FAKE_NODE" --state-dir /var/lib/k4d --install-dir /usr/local/lib/k4d --print-unit
expect_reject 'alt special-use namespace' \
  --public-host resolver.alt --binary "$FAKE_NODE" --state-dir /var/lib/k4e --install-dir /usr/local/lib/k4e --print-unit
expect_reject 'single-label hostname' \
  --public-host localhost --binary "$FAKE_NODE" --state-dir /var/lib/k5 --install-dir /usr/local/lib/k5 --print-unit
expect_reject 'port zero' \
  --public-host 1.1.1.1 --port 0 --binary "$FAKE_NODE" --state-dir /var/lib/k6 --install-dir /usr/local/lib/k6 --print-unit
expect_reject 'privileged port below service floor' \
  --public-host 1.1.1.1 --port 1023 --binary "$FAKE_NODE" --state-dir /var/lib/k6b --install-dir /usr/local/lib/k6b --print-unit
expect_reject 'port above range' \
  --public-host 1.1.1.1 --port 65536 --binary "$FAKE_NODE" --state-dir /var/lib/k7 --install-dir /usr/local/lib/k7 --print-unit
expect_reject 'status interval below minimum' \
  --public-host 1.1.1.1 --status-interval 9 --binary "$FAKE_NODE" --state-dir /var/lib/k8 --install-dir /usr/local/lib/k8 --print-unit
expect_reject 'relative state path' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir relative/state --install-dir /usr/local/lib/k9 --print-unit
expect_reject 'unsafe install path' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var/lib/k10 --install-dir '/usr/local/lib/bad path' --print-unit
expect_reject 'state/install collision' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var/lib/same --install-dir /var/lib/same --print-unit
expect_reject 'lexical state/install collision' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var/lib/konofix-alias/../same --install-dir /var/lib/same --print-unit
expect_reject 'symlink-resolved state/install collision' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir "$TMP/state-link" --install-dir "$TMP/alias-target" --print-unit
expect_reject 'state directory inside install directory' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /opt/konofix/service/state --install-dir /opt/konofix/service --print-unit
expect_reject 'install directory inside state directory' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /opt/konofix/service --install-dir /opt/konofix/service/bin --print-unit
expect_reject 'filesystem root as state directory' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir / --install-dir /usr/local/lib/k-root --print-unit
expect_reject 'top-level state directory' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var --install-dir /usr/local/lib/k-var --print-unit
expect_reject 'top-level install directory' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var/lib/k-usr --install-dir /usr --print-unit
expect_reject 'missing binary' \
  --public-host 1.1.1.1 --binary "$TMP/missing" --state-dir /var/lib/k11 --install-dir /usr/local/lib/k11 --print-unit
expect_reject 'start-now without install' \
  --public-host 1.1.1.1 --binary "$FAKE_NODE" --state-dir /var/lib/k12 --install-dir /usr/local/lib/k12 --start-now

BAD_NODE="$TMP/not-konofix"
printf '#!/usr/bin/env bash\necho other\n' >"$BAD_NODE"
chmod +x "$BAD_NODE"
expect_reject 'binary identity mismatch' \
  --public-host 1.1.1.1 --binary "$BAD_NODE" --state-dir /var/lib/k13 --install-dir /usr/local/lib/k13 --print-unit

bash -n "$INSTALLER"
printf 'Linux public Node installer self-tests passed.\n'
