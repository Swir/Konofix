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

const sliceBetween = (text, startMarker, endMarker, label) => {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    fail(`${label}: start marker is missing.`);
    return '';
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    fail(`${label}: end marker is missing.`);
    return text.slice(start);
  }
  return text.slice(start, end);
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

const spawnedTask = sliceBetween(
  rust,
  'tauri::async_runtime::spawn(async move {',
  '\n    });',
  'spawned network task',
);
requireText(
  spawnedTask,
  'let task_result = network_task(',
  'network task result must be captured before unconditional owned cleanup.',
);
requireText(
  spawnedTask,
  'nick_for_task,',
  'spawned network task must receive the validated nickname.',
);
requireText(
  spawnedTask,
  'nick_color.clone(),',
  'spawned network task must receive the validated nickname color.',
);
requireText(
  spawnedTask,
  ')\n        .await;',
  'captured network task must be awaited before task-owned cleanup.',
);
requireText(rust, 'let owned_session =\n            clear_network_sender_if_current(app_state.inner(), &task_tx).unwrap_or(false);', 'network task cleanup must run after every network task return, including clean exits.');
requireText(rust, 'if let Err(err) = task_result {\n            if owned_session {\n                let _ = app.emit("network-error", err);', 'terminal network-error must be emitted only for an owned fatal exit.');
requireText(rust, 'fn owned_clean_exit_cleanup_allows_reconnect()', 'clean task exit/reconnect regression test is missing.');
const taskResultIndex = rust.indexOf('let task_result =');
const taskCleanupIndex = rust.indexOf('let owned_session =', taskResultIndex);
const taskErrorIndex = rust.indexOf('if let Err(err) = task_result', taskResultIndex);
if (taskResultIndex < 0 || taskCleanupIndex < 0 || taskErrorIndex < 0 || !(taskResultIndex < taskCleanupIndex && taskCleanupIndex < taskErrorIndex)) {
  fail('task-owned sender cleanup must occur after every network task return and before error-only handling.');
}
requireText(
  rust,
  'Err(_) => {\n            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);\n            return Err("Nie udało się uruchomić warstwy P2P.".to_string());\n        }',
  'cancelled ready handshake must clear only its own startup session.',
);
requireText(
  rust,
  'Err(err) => {\n            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);\n            Err(err)\n        }',
  'failed ready result must clear only its own startup session.',
);
requireText(rust, 'fn take_network_sender(', 'explicit disconnect must use the idempotent sender-take helper.');
requireText(rust, 'let tx = take_network_sender(state.inner())?;', 'disconnect_network must atomically take the current sender.');
requireText(rust, 'mod network_session_state_tests {', 'Rust lifecycle regression tests are missing.');
requireText(rust, 'fn a_task_can_clear_only_the_sender_it_owns()', 'stale-task ownership regression test is missing.');
requireText(rust, 'fn overlapping_start_is_rejected_and_cleanup_allows_reconnect()', 'overlapping-start/reconnect regression test is missing.');
requireText(rust, 'fn explicit_sender_take_is_idempotent()', 'idempotent disconnect-state regression test is missing.');

if (/if state\.tx\.lock\([^\n]+\)\?\.is_some\(\)[\s\S]{0,500}\*state\.tx\.lock\([^\n]+\)\?\s*=\s*Some\(tx\)/.test(rust)) {
  fail('start_network regressed to a check-then-set sender race.');
}

requireText(ui, 'let sessionRevision = 0;', 'frontend must track lifecycle revisions across asynchronous startup.');
requireText(ui, 'let connectPending = false;', 'frontend must track an in-flight network start.');
requireText(ui, 'if (connectPending) return;', 'frontend must reject overlapping local connect attempts.');
requireText(ui, 'connectPending = true;\n  const revision = ++sessionRevision;', 'each frontend connect attempt must own a lifecycle revision.');
requireText(
  ui,
  'if (revision !== sessionRevision) return;\n    connectPending = false;\n    state.nick = result.nick;',
  'a stale successful start result must not resurrect a session after terminal recovery.',
);
requireText(
  ui,
  'catch (e) {\n    if (revision !== sessionRevision) return;\n    connectPending = false;',
  'a stale rejected start result must not overwrite a newer/reset login view.',
);
requireText(ui, 'function resetSessionView(errorMessage?: string) {', 'frontend must centralize terminal/local session reset.');
requireText(ui, 'sessionRevision += 1;\n  connectPending = false;', 'session reset must invalidate any in-flight startup before touching UI state.');
for (const [needle, message] of [
  ["document.querySelectorAll('.modal-wrap').forEach(el => el.remove());", 'session reset must close stale modals.'],
  ['state.connected = false;', 'session reset must leave connected state.'],
  ['state.peers.clear();', 'session reset must clear stale peer state.'],
  ["state.rooms = new Map([['world', { id: 'world', title: '# WORLD' }]]);", 'session reset must clear stale room state.'],
  ["state.messages = new Map([['world', []]]);", 'session reset must clear stale message state.'],
  ['state.transfers.clear();', 'session reset must clear stale transfer state.'],
  ['state.status = { ...EMPTY_STATUS };', 'session reset must restore offline network status.'],
  ['resetSessionView();', 'explicit frontend disconnect must share the canonical reset path.'],
]) {
  requireText(ui, needle, message);
}

requireText(
  ui,
  "await listen<string>('network-error', async event => {\n    if (!state.connected && !connectPending) return;\n    const message = t('network.error', { error: event.payload });\n    try { await invoke('disconnect_network'); } catch {}\n    resetSessionView(message);\n  });",
  'terminal network-error recovery must cover both connected sessions and in-flight startup, converge backend disconnect and invalidate stale startup results.',
);

if (!process.exitCode) {
  console.log('Network-session lifecycle policy: atomic start, validated identity/color handoff, channel-owned task cleanup, startup-safe terminal recovery, idempotent disconnect and terminal UI reset are enforced.');
}
