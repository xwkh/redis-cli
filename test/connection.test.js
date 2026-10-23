import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionOptions } from '../src/connection.js';
import { validateContext } from '../src/config.js';

test('connection uses decoded credentials directly, RESP2, and disables reconnects and offline queueing', () => {
  const options = connectionOptions(validateContext({ host: '::1', port: 6380, database: 2 }), { username: '', password: 'p@ss:"word/中文' }, 1000);
  assert.equal(options.RESP, 2);
  assert.equal(options.url, undefined);
  assert.equal(options.socket.host, '::1'); assert.equal(options.socket.port, 6380);
  assert.equal(options.database, 2); assert.equal(options.username, undefined);
  assert.equal(options.password, 'p@ss:"word/中文');
  assert.equal(options.socket.connectTimeout, 1000);
  assert.equal(options.socket.reconnectStrategy, false);
  assert.equal(options.disableOfflineQueue, true);
  assert.equal(connectionOptions(validateContext({}), { username: 'reader', password: 'secret' }, 30000).username, 'reader');
});

test('TLS validates peers and loads explicit certificates without mutating configuration', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-cli-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const c = validateContext({ tls: true, tls_ca_file: path.join(directory, 'ca'), tls_certificate_file: path.join(directory, 'cert'), tls_key_file: path.join(directory, 'key') });
  fs.writeFileSync(c.tls_ca_file, 'ca'); fs.writeFileSync(c.tls_certificate_file, 'cert'); fs.writeFileSync(c.tls_key_file, 'key');
  const options = connectionOptions(c, null, 30000);
  assert.equal(options.socket.rejectUnauthorized, true);
  assert.equal(options.socket.tls, true);
  assert.equal(options.socket.ca.toString(), 'ca');
  assert.equal(options.socket.cert.toString(), 'cert');
  assert.equal(options.socket.key.toString(), 'key');
  assert.equal(c.tls_key_file, path.join(directory, 'key'));
  assert.equal(options.password, undefined);
});
