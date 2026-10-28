import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('spawned mcp server lists exactly four tools over stdio', async () => {
  const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.js');
  const child = spawn(process.execPath, [main], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await new Promise((r) => setTimeout(r, 500));
  child.kill();
  const lines = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const list = lines.find((l) => l.id === 2);
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['sandbox_create', 'sandbox_list', 'sandbox_exec', 'sandbox_destroy'],
  );
});
