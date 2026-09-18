import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const checker = path.resolve('scripts/check-network-session-lifecycle.mjs');
const rustSource = fs.readFileSync('src-tauri/src/lib.rs', 'utf8').replaceAll('\r\n', '\n');
const uiSource = fs.readFileSync('src/main.ts', 'utf8').replaceAll('\r\n', '\n');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-network-lifecycle-'));

const run = (rust, ui) => {
  const rustPath = path.join(tempDir, 'lib.rs');
  const uiPath = path.join(tempDir, 'main.ts');
  fs.writeFileSync(rustPath, rust, 'utf8');
  fs.writeFileSync(uiPath, ui, 'utf8');
  return spawnSync(process.execPath, [checker, rustPath, uiPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
};

const mutateOnce = (text, from, to) => {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Test fixture source not found: ${from}`);
  if (text.indexOf(from, first + from.length) >= 0) {
    throw new Error(`Test fixture source is not unique: ${from}`);
  }
  return text.slice(0, first) + to + text.slice(first + from.length);
};

const baseline = run(rustSource, uiSource);
if (baseline.status !== 0) {
  console.error(baseline.stdout);
  console.error(baseline.stderr);
  throw new Error('Canonical lifecycle implementation must pass before adversarial mutations run.');
}

const terminalRecovery = "await listen<string>('network-error', async event => {\n    if (!state.connected && !connectPending) return;\n    const message = t('network.error', { error: event.payload });\n    try { await invoke('disconnect_network'); } catch {}\n    resetSessionView(message);\n  });";

const cases = [
  {
    name: 'channel ownership comparison removed',
    target: 'rust',
    source: 'current.same_channel(task_tx)',
    replacement: 'true /* stale task can clear anything */',
    expected: 'same_channel',
  },
  {
    name: 'fatal task emits terminal error without owning active session',
    target: 'rust',
    source: 'if clear_network_sender_if_current(app_state.inner(), &task_tx).unwrap_or(false) {\n                let _ = app.emit("network-error", err);',
    replacement: 'let _ = clear_network_sender_if_current(app_state.inner(), &task_tx);\n            if true {\n                let _ = app.emit("network-error", err);',
    expected: 'only by the task',
  },
  {
    name: 'start stops using atomic install helper',
    target: 'rust',
    source: 'install_network_sender(state.inner(), tx.clone())?;',
    replacement: '*state.tx.lock().unwrap() = Some(tx.clone());',
    expected: 'start_network must use',
  },
  {
    name: 'cancelled startup handshake clears state blindly',
    target: 'rust',
    source: 'Err(_) => {\n            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);\n            return Err("Nie udało się uruchomić warstwy P2P.".to_string());\n        }',
    replacement: 'Err(_) => {\n            let _ = state.tx.lock().map(|mut guard| guard.take());\n            return Err("Nie udało się uruchomić warstwy P2P.".to_string());\n        }',
    expected: 'cancelled ready handshake',
  },
  {
    name: 'explicit startup failure clears state blindly',
    target: 'rust',
    source: 'Err(err) => {\n            let _ = clear_network_sender_if_current(state.inner(), &startup_tx);\n            Err(err)\n        }',
    replacement: 'Err(err) => {\n            let _ = state.tx.lock().map(|mut guard| guard.take());\n            Err(err)\n        }',
    expected: 'failed ready result',
  },
  {
    name: 'disconnect bypasses idempotent take helper',
    target: 'rust',
    source: 'let tx = take_network_sender(state.inner())?;',
    replacement: 'let tx = state.tx.lock().unwrap().take();',
    expected: 'disconnect_network must atomically take',
  },
  {
    name: 'frontend permits overlapping local connect attempts',
    target: 'ui',
    source: 'if (connectPending) return;',
    replacement: '/* duplicate local connect allowed */',
    expected: 'reject overlapping local connect attempts',
  },
  {
    name: 'frontend terminal handler ignores fatal startup errors',
    target: 'ui',
    source: 'if (!state.connected && !connectPending) return;',
    replacement: 'if (!state.connected) return;',
    expected: 'both connected sessions and in-flight startup',
  },
  {
    name: 'stale successful startup can resurrect reset UI',
    target: 'ui',
    source: 'if (revision !== sessionRevision) return;\n    connectPending = false;\n    state.nick = result.nick;',
    replacement: 'connectPending = false;\n    state.nick = result.nick;',
    expected: 'stale successful start result',
  },
  {
    name: 'stale rejected startup can overwrite reset login',
    target: 'ui',
    source: 'catch (e) {\n    if (revision !== sessionRevision) return;\n    connectPending = false;',
    replacement: 'catch (e) {\n    connectPending = false;',
    expected: 'stale rejected start result',
  },
  {
    name: 'session reset fails to invalidate in-flight startup',
    target: 'ui',
    source: 'sessionRevision += 1;\n  connectPending = false;',
    replacement: 'connectPending = false;',
    expected: 'invalidate any in-flight startup',
  },
  {
    name: 'frontend terminal handler no longer disconnects backend',
    target: 'ui',
    source: terminalRecovery,
    replacement: "await listen<string>('network-error', async event => {\n    if (!state.connected && !connectPending) return;\n    const message = t('network.error', { error: event.payload });\n    /* backend convergence removed */\n    resetSessionView(message);\n  });",
    expected: 'terminal network-error recovery',
  },
  {
    name: 'frontend terminal handler no longer resets UI',
    target: 'ui',
    source: terminalRecovery,
    replacement: "await listen<string>('network-error', async event => {\n    if (!state.connected && !connectPending) return;\n    const message = t('network.error', { error: event.payload });\n    try { await invoke('disconnect_network'); } catch {}\n    addSystem('world', message);\n  });",
    expected: 'terminal network-error recovery',
  },
  {
    name: 'session reset retains stale transfers',
    target: 'ui',
    source: 'state.transfers.clear();',
    replacement: '/* transfers accidentally retained */',
    expected: 'clear stale transfer state',
  },
];

for (const testCase of cases) {
  const rust = testCase.target === 'rust'
    ? mutateOnce(rustSource, testCase.source, testCase.replacement)
    : rustSource;
  const ui = testCase.target === 'ui'
    ? mutateOnce(uiSource, testCase.source, testCase.replacement)
    : uiSource;
  const result = run(rust, ui);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error(`Mutation '${testCase.name}' unexpectedly passed the lifecycle policy checker.`);
  }
  if (!output.includes(testCase.expected)) {
    throw new Error(`Mutation '${testCase.name}' failed for the wrong reason. Expected '${testCase.expected}', got:\n${output}`);
  }
}

fs.rmSync(tempDir, { recursive: true, force: true });
console.log(`Network-session lifecycle adversarial policy tests passed (${cases.length} mutations rejected).`);
