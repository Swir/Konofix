import fs from 'node:fs';
const path = process.argv[2];
if (!path) throw new Error('Pass the path to the updater PUBLIC key file. Do not pass a private key.');
const publicKey = fs.readFileSync(path,'utf8').trim();
const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
if (publicKey !== config.plugins.updater.pubkey) throw new Error('Public key mismatch. Do not upload the corresponding private key or publish an updater signed with it.');
console.log('Public key matches the client. Verify a signed test artifact before configuring publication secrets.');
