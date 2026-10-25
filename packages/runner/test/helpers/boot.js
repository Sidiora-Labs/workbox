import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Peer, PROTOCOL_VERSION } from '@workbox/protocol';

/** A temp dir with a boot file and a socket path, removed by cleanup(). */
export function bootFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-runner-'));
  const socket = path.join(dir, 'runner.sock');
  const boot = {
    bootId: 'BOOT00000000000000000000A1',
    nonce: 'n'.repeat(64),
    sandboxId: 'SBX000000000000000000000A1',
    protocol: PROTOCOL_VERSION,
    runtime: 'test',
    socket,
    issuedAt: Date.now(),
    ...overrides,
  };
  const bootFile = path.join(dir, 'boot.json');
  fs.writeFileSync(bootFile, JSON.stringify(boot));
  return {
    dir,
    socket,
    boot,
    bootFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Connect a Peer to the runner socket. */
export async function connectPeer(socketPath, name = 'test') {
  const sock = net.connect(socketPath);
  await once(sock, 'connect');
  return new Peer(sock, { name });
}
