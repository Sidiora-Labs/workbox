import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';

/**
 * A self-signed certificate for 127.0.0.1 and localhost, made by the openssl CLI in `dir`.
 * @param {string} dir @param {string} name file stem and common name
 * @returns {{certFile: string, keyFile: string, cert: Buffer, key: Buffer, fingerprint: string}}
 */
export function selfSigned(dir, name) {
  const certFile = path.join(dir, `${name}.crt`);
  const keyFile = path.join(dir, `${name}.key`);
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'pipe' },
  );
  const cert = fs.readFileSync(certFile);
  return {
    certFile,
    keyFile,
    cert,
    key: fs.readFileSync(keyFile),
    fingerprint: new X509Certificate(cert).fingerprint256,
  };
}

/**
 * Send a WebSocket upgrade request over TLS and return the head of the answer (status line and
 * headers) once it is complete.
 * @param {number} port @param {string} target
 * @param {{ca: (string|Buffer)[], headers?: Record<string, string>}} opts
 * @returns {Promise<string>}
 */
export function tlsUpgrade(port, target, opts) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, ca: opts.ca });
    let got = '';
    sock.on('data', (d) => {
      got += d;
      const end = got.indexOf('\r\n\r\n');
      if (end === -1) return;
      sock.destroy();
      resolve(got.slice(0, end));
    });
    sock.on('error', reject);
    const lines = [
      `GET ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ];
    sock.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}
