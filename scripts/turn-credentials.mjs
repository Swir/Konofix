// Run on the operator's host, never bundle the shared secret with the desktop app.
import { createHmac } from 'node:crypto';
const secret = process.env.KONOFIX_TURN_SHARED_SECRET;
const minutes = Number(process.argv[2] ?? 60);
const label = process.argv[3] ?? 'konofix';
if (!secret || secret.length < 32 || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !/^[a-zA-Z0-9_-]{1,64}$/.test(label)) {
  throw new Error('Provide KONOFIX_TURN_SHARED_SECRET (32+ characters), lifetime 1–1440 minutes and an optional simple username label.');
}
const expires = Math.floor(Date.now() / 1000) + minutes * 60;
const username = `${expires}:${label}`;
console.log(JSON.stringify({ username, credential: createHmac('sha1', secret).update(username).digest('base64'), expiresAt: new Date(expires * 1000).toISOString() }, null, 2));
