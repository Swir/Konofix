import fs from 'node:fs';

const rustPath = process.argv[2] ?? 'src-tauri/src/lib.rs';
const uiPath = process.argv[3] ?? 'src/main.ts';
const rust = fs.readFileSync(rustPath, 'utf8').replaceAll('\r\n', '\n');
const ui = fs.readFileSync(uiPath, 'utf8').replaceAll('\r\n', '\n');

const fail = (message) => {
  console.error(`NETWORK SESSION LIFECYCLE ERROR: ${message}`);
  process.exitCode = 1;
};

const requireText = (text, needle, message) => {
  if (!text.includes(needle)) fail(message);
};

requireText(rust, 'fn install_network_sender(', 'active network sender must be installed through one atomic helper.');
requireText(rust, 'let mut guard = state.tx.lock().map_err(|_| "Błąd blokady stanu")?;', 'sender installation/cleanup must remain lock-protected.');
requireText(rust, 'if guard.is_some() {', 'atomic sender installation must reject an overlapping start while holding the state lock.');
requireText(rust, '*guard = Some(tx);', 'atomic sender installation must store the new sender under the same lock.');
requireText(rust, 'fn clear_network_sender_if_current(', 'task-owned cleanup helper is missing.');
requireText(rust, 'current.same_channel(task_tx)', 'task cleanup must prove ownership with Tokio Sender::same_channel.');
requireText(rust, 'if owns_current_session {\n        guard.take();', 'a task may clear AppState only after proving sender ownership.');
requireText(rust, 'install_network_sender(state.inner(), tx.clone())?;', 'start_network must use the atomic install helper.');
requireText(rust, 'let task_tx = tx.clone();', 'spawned task must retain an ownership sender clone.');
requireText(rust, 'let startup_tx = tx;', 'startup handshake cleanup must retain the exact installed channel.');
requireText(rust, 'clear_network_sender_if_current(app_state.inner(), &task_tx).unwrap_or(false)', 'fatal task cleanup must be channel-owned.');
requireText(rust, 'if clear_network_sender_if_current(app_state.inner(), &task_tx).unwrap_or(false) {\n                let _ = app.emit("network-error", err);', 'terminal network-error must be emitted only by the task that successfully clears the active session.');
requireText(rust, 'let _ = clear_network_sender_if_current(state.inner(), &startup_tx);', 'failed ready handshake must clear only its own startup session.');
requireText(rust, 'fn take_network_sender(', 'explicit disconnect must use the idempotent sender-take helper.');
requireText(rust, 'let tx = take_network_sender(state.inner())?;', 'disconnect_network must atomically take the current sender.');
requireText(rust, 'mod network_session_state_tests {', 'Rust lifecycle regression tests are missing.');
requireText(rust, 'fn a_task_can_clear_only_the_sender_it_owns()', 'stale-task ownership regression test is missing.');
requireText(rust, 'fn overlapping_start_is_rejected_and_cleanup_allows_reconnect()', 'overlapping-start/reconnect regression test is missing.');
requireText(rust, 'fn explicit_sender_take_is_idempotent()', 'idempotent disconnect-state regression test is missing.');

if (/if state\.tx\.lock\([^\n]+\)\?\.is_some\(\)[\s\S]{0,500}\*state\.tx\.lock\([^\n]+\)\?\s*=\s*Some\(tx\)/.test(rust)) {
  fail('start_network regressed to a check-then-set sender race.');
}

requireText(ui, 'function resetSessionView(errorMessage?: string) {', 'frontend must centralize terminal/local session reset.');
for (const [needle, message] of [
  ["document.querySelectorAll('.modal-wrap').forEach(el => el.remove());", 'session reset must close stale modals.'],
  ['state.connected = false;', 'session reset must leave connected state.'],
  ['state.peers.clear();', 'session reset must clear stale peer state.'],
  ["state.rooms = new Map([['world', { id: 'world', title: '# WORLD' }]]);", 'session reset must clear stale room state.'],
  ["state.messages = new Map([['world', []]]);", 'session reset must clear stale message state.'],
  ['state.transfers.clear();', 'session reset must clear stale transfer state.'],
  ['state.status = { ...EMPTY_STATUS };', 'session reset must restore offline network status.'],
  ['resetSessionView();', 'explicit frontend disconnect must share the canonical reset path.'],
  ["await listen<string>('network-error', async event => {", 'network-error listener must own terminal recovery.'],
  ["try { await invoke('disconnect_network'); } catch {}", 'terminal frontend recovery must make backend disconnect idempotently converge.'],
  ['resetSessionView(message);', 'terminal network error must return the UI to login with the error surfaced.'],
]) {
  requireText(ui, needle, message);
}

if (!process.exitCode) {
  console.log('Network-session lifecycle policy: atomic start, channel-owned task cleanup, idempotent disconnect and terminal UI reset are enforced.');
}
