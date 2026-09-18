from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one replacement target, found {count}')
    p.write_text(text.replace(old, new), encoding='utf-8', newline='\n')


replace_once(
    'scripts/public-node.ps1',
    "    @('2002::', 16)\n",
    "    @('2002::', 16),\n    @('3fff::', 20)\n",
    'Windows RFC 9637 insertion',
)

# Rust 1.98 flags the old guarded destructuring form as clippy::redundant_guards.
# Match the final-connection count directly without changing behavior.
replace_once(
    'src-tauri/src/bin/konofix-node.rs',
    '                    SwarmEvent::ConnectionClosed { peer_id, num_established, .. } if num_established == 0 => {\n',
    '                    SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } => {\n',
    'Rust 1.98 ConnectionClosed pattern',
)

print('Windows RFC 9637 range and current-stable Clippy compatibility applied')
