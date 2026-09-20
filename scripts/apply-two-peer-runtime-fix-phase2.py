from pathlib import Path

lib = Path(__file__).resolve().parents[1] / "src-tauri" / "src" / "lib.rs"
text = lib.read_text(encoding="utf-8")
old = '''                                    if !file_response_matches_outbound_kind(meta.kind, &response) {
                                        if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                            emit_transfer(
                                                &app,
                                                &file_view_outgoing(
                                                    &meta.transfer_id,
                                                    &transfer,
                                                    "failed",
                                                    None,
                                                    Some("Nieoczekiwana odpowiedź P2P dla bieżącego etapu transferu.".into()),
                                                ),
                                            );
                                        }
                                        continue;
                                    }
'''
new = '''                                    if !file_response_matches_outbound_kind(meta.kind, &response) {
                                        let protocol_error = "Nieoczekiwana odpowiedź P2P dla bieżącego etapu transferu.".to_string();
                                        match meta.kind {
                                            OutboundKind::Accept => {
                                                if let Some(transfer) = incoming.remove(&meta.transfer_id) {
                                                    let temp_path = transfer.temp_path.clone();
                                                    let _ = tokio::fs::remove_file(&temp_path).await;
                                                    emit_transfer(
                                                        &app,
                                                        &file_view_incoming(
                                                            &meta.transfer_id,
                                                            &transfer,
                                                            "failed",
                                                            None,
                                                            Some(protocol_error),
                                                        ),
                                                    );
                                                }
                                            }
                                            OutboundKind::Offer | OutboundKind::Chunk | OutboundKind::Complete => {
                                                if let Some(transfer) = outgoing.remove(&meta.transfer_id) {
                                                    emit_transfer(
                                                        &app,
                                                        &file_view_outgoing(
                                                            &meta.transfer_id,
                                                            &transfer,
                                                            "failed",
                                                            None,
                                                            Some(protocol_error),
                                                        ),
                                                    );
                                                }
                                            }
                                            OutboundKind::Reject | OutboundKind::Cancel => {}
                                        }
                                        continue;
                                    }
'''
if text.count(old) != 1:
    raise SystemExit(f"wrong-phase guard: expected one source match, found {text.count(old)}")
lib.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Hardened wrong-phase cleanup for receiver-side Accept control requests.")
