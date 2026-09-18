from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    text = file_path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    file_path.write_text(text.replace(old, new, 1), encoding="utf-8")


lib = "src-tauri/src/lib.rs"
replace_once(
    lib,
    "const FILE_CHUNK_SIZE: usize = 256 * 1024;\nconst MAX_FILE_SIZE: u64 = 32 * 1024 * 1024 * 1024;\n",
    "const FILE_CHUNK_SIZE: usize = 256 * 1024;\nconst MAX_FILE_OFFER_NAME_BYTES: usize = 4 * 1024;\nconst MAX_FILE_REQUEST_WIRE_BYTES: u64 = 320 * 1024;\nconst MAX_FILE_SIZE: u64 = 32 * 1024 * 1024 * 1024;\n",
)
replace_once(
    lib,
    "fn safe_filename(raw: &str) -> String {\n",
    "fn file_offer_name_error(file_name: &str) -> Option<&'static str> {\n    if file_name.len() > MAX_FILE_OFFER_NAME_BYTES {\n        Some(\"File name exceeds the 4096-byte protocol limit.\")\n    } else {\n        None\n    }\n}\n\nfn safe_filename(raw: &str) -> String {\n",
)
replace_once(
    lib,
    """            let rr_cfg =
                request_response::Config::default().with_request_timeout(Duration::from_secs(300));
            let file_transfer = request_response::cbor::Behaviour::<FileRequest, FileResponse>::new(
                [(
                    StreamProtocol::new(FILE_PROTOCOL),
                    request_response::ProtocolSupport::Full,
                )],
                rr_cfg,
            );
""",
    """            let rr_cfg =
                request_response::Config::default().with_request_timeout(Duration::from_secs(300));
            let file_codec = request_response::cbor::codec::Codec::<FileRequest, FileResponse>::default()
                .set_request_size_maximum(MAX_FILE_REQUEST_WIRE_BYTES);
            let file_transfer = request_response::cbor::Behaviour::<FileRequest, FileResponse>::with_codec(
                file_codec,
                [(
                    StreamProtocol::new(FILE_PROTOCOL),
                    request_response::ProtocolSupport::Full,
                )],
                rr_cfg,
            );
""",
)
replace_once(
    lib,
    """                                            if Uuid::parse_str(&transfer_id).is_err() {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Rejected { reason: "Invalid transfer ID.".into() });
                                                continue;
                                            }
                                            if pending_incoming.contains_key(&transfer_id)
""",
    """                                            if Uuid::parse_str(&transfer_id).is_err() {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(channel, FileResponse::Rejected { reason: "Invalid transfer ID.".into() });
                                                continue;
                                            }
                                            if let Some(reason) = file_offer_name_error(&file_name) {
                                                let _ = swarm.behaviour_mut().file_transfer.send_response(
                                                    channel,
                                                    FileResponse::Rejected { reason: reason.into() },
                                                );
                                                continue;
                                            }
                                            if pending_incoming.contains_key(&transfer_id)
""",
)
replace_once(
    lib,
    """    #[test]
    fn pending_offer_ttl_expires_only_after_the_boundary() {
""",
    """    #[test]
    fn inbound_offer_name_limit_is_measured_in_encoded_utf8_bytes() {
        let ascii_at_limit = "a".repeat(MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&ascii_at_limit), None);
        assert_eq!(
            file_offer_name_error(&(ascii_at_limit + "a")),
            Some("File name exceeds the 4096-byte protocol limit.")
        );

        let two_byte_at_limit = "é".repeat(MAX_FILE_OFFER_NAME_BYTES / "é".len());
        assert_eq!(two_byte_at_limit.len(), MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&two_byte_at_limit), None);
        assert!(file_offer_name_error(&(two_byte_at_limit + "é")).is_some());

        let four_byte_at_limit = "🧪".repeat(MAX_FILE_OFFER_NAME_BYTES / "🧪".len());
        assert_eq!(four_byte_at_limit.len(), MAX_FILE_OFFER_NAME_BYTES);
        assert_eq!(file_offer_name_error(&four_byte_at_limit), None);
        assert!(file_offer_name_error(&(four_byte_at_limit + "🧪")).is_some());
    }

    #[test]
    fn request_codec_limit_preserves_a_large_chunk_overhead_budget() {
        assert_eq!(MAX_FILE_REQUEST_WIRE_BYTES, 320 * 1024);
        assert!(
            MAX_FILE_REQUEST_WIRE_BYTES
                >= (FILE_CHUNK_SIZE as u64).saturating_add(64 * 1024)
        );
    }

    #[test]
    fn pending_offer_ttl_expires_only_after_the_boundary() {
""",
)

docs = "docs/FILE_TRANSFER_SECURITY.md"
replace_once(
    docs,
    "- Transfer IDs must be UUIDs and cannot collide with another active incoming, outgoing or pending transfer.\n- Declared file size is capped at 32 GiB and chunks are capped at 256 KiB. Empty chunks are rejected and do not refresh receive-side liveness, so a sender cannot keep a slot alive with zero-byte traffic.\n",
    "- Transfer IDs must be UUIDs and cannot collide with another active incoming, outgoing or pending transfer.\n- Untrusted incoming `Offer.file_name` values are rejected above 4096 encoded UTF-8 bytes before filename sanitization, receiver-state insertion or desktop event emission. This protocol-input ceiling is intentionally separate from the stricter 180-byte sanitized filesystem-component bound.\n- The CBOR request/response behaviour uses an explicit 320 KiB maximum request frame instead of the codec default 1 MiB. That ceiling keeps a 64 KiB budget above the reviewed 256 KiB chunk size while reducing the amount of request data decoded for a single file-transfer request.\n- Declared file size is capped at 32 GiB and chunks are capped at 256 KiB. Empty chunks are rejected and do not refresh receive-side liveness, so a sender cannot keep a slot alive with zero-byte traffic.\n",
)
replace_once(
    docs,
    "Regression tests cover pre-existing partial files with sentinel bytes, concurrent reservations for the same requested filename, a final destination appearing after temporary reservation, bounded reservation exhaustion, no-clobber finalization, successful promotion, multi-byte filename byte bounds plus retry/temporary suffix geometry, pending-offer TTL boundaries, accepted-transfer inactivity TTL boundaries, final-connection-only cleanup, peer-scoped outgoing reclamation and scoped request-metadata pruning. Cancellation, rejected/failed acceptance, hash mismatch, disconnect, inactivity timeout and finalization failure clean up only state owned by the affected transfer.\n",
    "Regression tests cover pre-existing partial files with sentinel bytes, concurrent reservations for the same requested filename, a final destination appearing after temporary reservation, bounded reservation exhaustion, no-clobber finalization, successful promotion, multi-byte filename byte bounds plus retry/temporary suffix geometry, encoded-byte file-offer admission boundaries, request-codec chunk headroom, pending-offer TTL boundaries, accepted-transfer inactivity TTL boundaries, final-connection-only cleanup, peer-scoped outgoing reclamation and scoped request-metadata pruning. Cancellation, rejected/failed acceptance, hash mismatch, disconnect, inactivity timeout and finalization failure clean up only state owned by the affected transfer.\n",
)

replace_once(
    "CHANGELOG.md",
    "## 0.4.2\n\n",
    "## 0.4.2\n\n- bounded untrusted inbound file-offer metadata before expensive filename handling: names above 4096 encoded UTF-8 bytes are rejected before sanitization/state/UI insertion, and the CBOR file-request codec now uses an explicit 320 KiB request ceiling that preserves at least 64 KiB of framing headroom above the 256 KiB chunk size; boundary tests cover ASCII and multi-byte UTF-8 without changing Real Internet Test credit,\n",
)

roadmap_anchor = "- Received filenames are additionally bounded to 180 encoded UTF-8 bytes after sanitization and before collision/temp suffixes are added, preserving short extensions and preventing multi-byte remote names from exceeding common per-component filesystem limits. Regression coverage verifies UTF-8 boundaries and worst-case retry/temp suffix geometry; this local hardening does not add Real Internet Test credit and the milestone remains 54/59.\n"
roadmap_note = "- Incoming file offers now also enforce a separate 4096-byte encoded UTF-8 protocol-name ceiling before sanitization/state/UI work, and the CBOR file-transfer request codec is explicitly capped at 320 KiB while retaining at least 64 KiB of framing headroom above the 256 KiB chunk size. Boundary tests cover ASCII/multi-byte names and codec geometry; this network-input hardening does not add Real Internet Test credit and the milestone remains 54/59.\n"
replace_once("ROADMAP.md", roadmap_anchor, roadmap_anchor + roadmap_note)

Path(".github/workflows/apply-inbound-offer-bounds.yml").unlink()
Path("scripts/apply-inbound-offer-bounds.py").unlink()
