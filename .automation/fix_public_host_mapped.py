from pathlib import Path

path = Path('src-tauri/src/bin/konofix-node.rs')
text = path.read_text(encoding='utf-8')

old = '''                let host = raw.trim().trim_matches(['[', ']']).to_string();
                if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) {
                    return Err(format!("Invalid public host: {raw}"));
                }
                public_host = Some(host);
'''
new = '''                let mut host = raw.trim().trim_matches(['[', ']']).to_string();
                if host.is_empty() || host.contains('/') || host.chars().any(char::is_whitespace) {
                    return Err(format!("Invalid public host: {raw}"));
                }
                if let Ok(IpAddr::V6(ip)) = host.parse::<IpAddr>() {
                    if let Some(mapped) = ip.to_ipv4_mapped() {
                        host = mapped.to_string();
                    }
                }
                public_host = Some(host);
'''
if old not in text:
    raise SystemExit('public-host parse anchor missing')
text = text.replace(old, new, 1)

anchor = '''    #[test]
    fn public_host_literal_policy_matches_deployment_preflight() {
'''
test = '''    #[test]
    fn normalizes_ipv4_mapped_public_host_before_address_generation() {
        let args = parse_args_from(vec![
            "--public-host".to_string(),
            "[::ffff:8.8.8.8]".to_string(),
        ])
        .expect("arguments should parse")
        .expect("help was not requested");
        assert_eq!(args.public_host.as_deref(), Some("8.8.8.8"));
    }

'''
if anchor not in text:
    raise SystemExit('public-host test anchor missing')
text = text.replace(anchor, test + anchor, 1)
path.write_text(text, encoding='utf-8')

checker_path = Path('scripts/check-public-host-policy.mjs')
checker = checker_path.read_text(encoding='utf-8')
needle = 'requireText("non-global IP literal", "fail-closed literal error");\n'
insert = needle + 'requireText("host = mapped.to_string()", "IPv4-mapped IPv6 normalization before multiaddr generation");\n'
if needle not in checker:
    raise SystemExit('policy checker anchor missing')
checker_path.write_text(checker.replace(needle, insert, 1), encoding='utf-8')

node_doc = Path('docs/NODE.md')
doc = node_doc.read_text(encoding='utf-8')
needle_doc = 'The raw binary now fails closed when `--public-host` is a non-global IP literal, before identity creation, listeners, or shareable-address output.'
replacement_doc = needle_doc + ' IPv4-mapped IPv6 literals are normalized to their IPv4 form before bootstrap multiaddresses are generated.'
if needle_doc not in doc:
    raise SystemExit('NODE documentation anchor missing')
node_doc.write_text(doc.replace(needle_doc, replacement_doc, 1), encoding='utf-8')

print('IPv4-mapped public-host normalization applied')
