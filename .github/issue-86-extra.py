from pathlib import Path

path = Path('scripts/public-node.ps1')
text = path.read_text(encoding='utf-8')
old = "    @('2002::', 16)\n"
new = "    @('2002::', 16),\n    @('3fff::', 20)\n"
if text.count(old) != 1:
    raise SystemExit(f'expected one Windows IPv6 insertion point, found {text.count(old)}')
path.write_text(text.replace(old, new), encoding='utf-8', newline='\n')
print('Windows RFC 9637 public-host range added')
