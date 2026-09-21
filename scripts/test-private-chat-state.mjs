import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const sourcePath = path.resolve('src/private-chat-state.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'konofix-private-chat-state-'));
try {
  const result = spawnSync(
    'npx',
    [
      'tsc', sourcePath,
      '--ignoreConfig',
      '--target', 'ES2022',
      '--module', 'ES2022',
      '--moduleResolution', 'bundler',
      '--outDir', tempDir,
      '--skipLibCheck',
      '--pretty', 'false',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to compile private-chat-state.ts for tests:\n${result.stdout}${result.stderr}`);
  }

  const output = fs.readFileSync(path.join(tempDir, 'private-chat-state.js'), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
  const mod = await import(moduleUrl);

  const legacyRoom = { id: 'legacy', title: '# LEGACY', owner: 'owner' };
  const legacySecurity = mod.roomSecurity(legacyRoom);
  if (legacySecurity.protected !== false || legacySecurity.revision !== 0) {
    throw new Error('Legacy room compatibility fallback must remain unlocked/revision 0.');
  }

  const lockedRoom = { id: 'locked', title: '# LOCKED', owner: 'owner', password_protected: true, auth_revision: 3 };
  if (!mod.roomNeedsPassword(lockedRoom, 'visitor')) {
    throw new Error('Protected room must request a password from non-owner peers.');
  }
  if (mod.roomNeedsPassword(lockedRoom, 'owner')) {
    throw new Error('Room owner must not be prompted for its own room password.');
  }
  const malformedLocked = mod.roomSecurity({ ...lockedRoom, auth_revision: -1 });
  if (!malformedLocked.protected || malformedLocked.revision !== 0) {
    throw new Error('Malformed lock metadata must remain visibly locked instead of downgrading.');
  }

  const store = new mod.PrivateConversationStore();
  const self = 'self';
  const alice = 'alice-peer';
  const bob = 'bob-peer';
  const incomingAlice = {
    id: 'm1', peer_id: alice, target_peer_id: self, nick: 'Alice', text: 'hello', timestamp: 1,
  };
  const incomingBob = {
    id: 'm2', peer_id: bob, target_peer_id: self, nick: 'Bob', text: 'secret', timestamp: 2,
  };
  const outgoingAlice = {
    id: 'm3', peer_id: self, target_peer_id: alice, nick: 'Self', text: 'reply', timestamp: 3,
  };

  if (!store.push(incomingAlice, self)?.inserted || store.unreadCount(alice) !== 1) {
    throw new Error('Incoming private message must create unread state for its peer.');
  }
  if (!store.push(incomingBob, self)?.inserted || store.unreadCount(bob) !== 1 || store.unreadTotal() !== 2) {
    throw new Error('Private conversations must keep unread state isolated per peer.');
  }
  store.open(alice);
  if (store.unreadCount(alice) !== 0 || store.unreadCount(bob) !== 1 || store.activePeer() !== alice) {
    throw new Error('Opening one private conversation must only clear that peer unread state.');
  }
  if (!store.push(outgoingAlice, self)?.inserted || store.unreadCount(alice) !== 0) {
    throw new Error('Local private messages must not create unread state.');
  }
  if (store.push(incomingAlice, self)?.inserted !== false || store.conversation(alice).length !== 2) {
    throw new Error('Duplicate private message IDs must not be inserted twice.');
  }
  if (store.push({ ...incomingAlice, id: 'bad', peer_id: self, target_peer_id: self }, self) !== null) {
    throw new Error('Self-to-self or unrelated private messages must not enter a conversation.');
  }
  store.close();
  if (store.activePeer() !== '' || store.conversation(alice).length !== 2) {
    throw new Error('Closing the view must preserve the in-session conversation history.');
  }
  store.reset();
  if (store.unreadTotal() !== 0 || store.conversation(alice).length !== 0) {
    throw new Error('Session reset must clear private messages and unread counters.');
  }

  console.log('Protected-room compatibility and private conversation state tests passed.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
