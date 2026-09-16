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
  'ProtectSystem=strict' \
  'ProtectHome=true' \
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' \
  'ReadWritePaths=/var/lib/konofix-selftest' \
  '--public-host 1.1.1.1' \
  '--identity-file /var/lib/konofix-selftest/node-identity.key' \
  '--health-file /var/lib/konofix-selftest/node-health.json'; do
  grep -Fq -- "$expected" <<<"$unit" || fail "Generated unit is missing: $expected"
done

preview="$(bash "$INSTALLER" \
  --public-host node.example.net \
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

expect_reject 'private address without lab override' \
  --public-host 10.0.0.5 --binary "$FAKE_NODE" --state-dir /var/lib/k1 --install-dir /usr/local/lib/k1 --print-unit
expect_reject 'CGNAT address without lab override' \
  --public-host 100.64.0.1 --binary "$FAKE_NODE" --state-dir /var/lib/k2 --install-dir /usr/local/lib/k2 --print-unit
expect_reject 'documentation address without lab override' \
  --public-host 203.0.113.10 --binary "$FAKE_NODE" --state-dir /var/lib/k3 --install-dir /usr/local/lib/k3 --print-unit
expect_reject 'reserved DNS suffix' \
  --public-host node.example --binary "$FAKE_NODE" --state-dir /var/lib/k4 --install-dir /usr/local/lib/k4 --print-unit
expect_reject 'single-label hostname' \
  --public-host localhost --binary "$FAKE_NODE" --state-dir /var/lib/k5 --install-dir /usr/local/lib/k5 --print-unit
expect_reject 'port zero' \
  --public-host 1.1.1.1 --port 0 --binary "$FAKE_NODE" --state-dir /var/lib/k6 --install-dir /usr/local/lib/k6 --print-unit
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
