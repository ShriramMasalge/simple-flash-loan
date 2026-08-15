#!/usr/bin/env node
// Copies the compiled contract's ZK assets from ../contracts/managed/flash-loan-pool:
//   - zkir + keys → public/zk (fetched over HTTP by FetchZkConfigProvider)
//   - contract JS → src/zk-contract (imported as a module — must live inside
//     the Vite graph; Vite refuses to import modules from /public).
// Run after `npm run compile`.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '..', '..', 'contracts', 'managed', 'flash-loan-pool');
const publicDest = path.resolve(__dirname, '..', 'public', 'zk');
const contractDest = path.resolve(__dirname, '..', 'src', 'zk-contract');

if (!fs.existsSync(path.join(src, 'zkir'))) {
  console.error('Compiled ZK assets not found — run `npm run compile` in the project root first.');
  process.exit(1);
}

fs.rmSync(publicDest, { recursive: true, force: true });
fs.mkdirSync(publicDest, { recursive: true });
for (const sub of ['zkir', 'keys']) {
  fs.cpSync(path.join(src, sub), path.join(publicDest, sub), { recursive: true });
}

fs.rmSync(contractDest, { recursive: true, force: true });
fs.mkdirSync(contractDest, { recursive: true });
fs.cpSync(path.join(src, 'contract'), contractDest, { recursive: true });

console.log('ZK assets synced: public/zk (zkir+keys) and src/zk-contract (contract JS).');