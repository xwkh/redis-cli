import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createClient } from '@redis/client';

const cli = path.resolve(process.env.REDIS_CLI_TEST_ENTRY || 'bin/redis-cli.js');
const password = `temporary-${crypto.randomBytes(8).toString('hex')}-p@ss:"word/中文`;
let directory, port, server, client, serverError;

async function invoke(args, { env = {}, success = true, input = '' } = {}) {
  const childEnv = { ...process.env, PATH: directory };
  delete childEnv.REDIS_CLI_USERNAME; delete childEnv.REDIS_CLI_PASSWORD;
  Object.assign(childEnv, env);
  const result = await new Promise(resolve => {
    const child = execFile(process.execPath, [cli, '--config', path.join(directory, 'config'), '--use-context', 'test', ...args], { encoding: 'utf8', env: childEnv, timeout: 45000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  assert.ok(!result.stdout.includes(password), 'password leaked to stdout');
  assert.ok(!result.stderr.includes(password), 'password leaked to stderr');
  if (success) assert.equal(result.status, 0, `${args.slice(0, 3).join(' ')}: ${result.stderr}`);
  return { ...result, data: result.stdout.trim() && !args.includes('ndjson') ? JSON.parse(result.stdout) : null, error: result.stderr.trim().startsWith('{"error":') ? JSON.parse(result.stderr).error : null };
}
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-cli-integration-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const config = path.join(directory, 'redis.conf');
  fs.writeFileSync(config, `bind 127.0.0.1\nport ${port}\nprotected-mode yes\nsave ""\nappendonly no\nrequirepass ${JSON.stringify(password)}\ndir ${directory}\n`, { mode: 0o600 });
  server = spawn(process.env.REDIS_CLI_TEST_SERVER || 'redis-server', [config], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.on('error', error => { serverError = error; });
  // Readiness contains no password and no server log is forwarded into CLI output.
  let ready = false, exited = false;
  server.on('exit', () => { exited = true; });
  server.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) ready = true; });
  server.stderr.resume();
  for (let i = 0; i < 200 && !ready; i++) {
    if (serverError) throw new Error('Test Redis server could not start. Set REDIS_CLI_TEST_SERVER to a redis-server executable.');
    if (exited) throw new Error('Test Redis server exited before readiness.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(ready, 'temporary Redis must be ready');
  client = createClient({ socket: { host: '127.0.0.1', port, reconnectStrategy: false }, password, disableClientInfo: true });
  client.on('error', () => {}); await client.connect();
  await client.set('string:hello', '中文 hello');
  await client.set('string:empty', '');
  await client.set('string:binary', Buffer.from([0xff, 0x00, 0xfe]));
  await client.set(Buffer.from([0xff, 0x01]), 'binary-key-value');
  await client.hSet('hash:user', Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field${i}`, `value${i}`])));
  await client.hSet('hash:user', '__proto__', 'ordinary-field');
  await client.rPush('list:queue', ['a', 'b', 'c']);
  await client.sAdd('set:tags', ['a', 'b', 'c']);
  await client.zAdd('zset:rank', [{ value: 'a', score: 1.5 }, { value: 'b', score: 2 }, { value: 'c', score: 3 }]);
  for (let i = 0; i < 3; i++) await client.xAdd('stream:events', '*', { kind: 'order', sequence: String(i) });
  await client.sendCommand(['ACL', 'SETUSER', 'reader', 'on', `>${password}`, '~*', '+@read', '+ping', '+select', '+info', '-keys']);
  await invoke(['config', 'set-context', 'test', '--host', '127.0.0.1', '--port', String(port)]);
  await invoke(['auth', 'login', '--credential-store', 'file', '--verify'], { env: { REDIS_CLI_PASSWORD: password } });
}, { timeout: 30000 });
after(async () => {
  if (client?.isOpen) client.destroy();
  if (server?.pid && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('password-only auth, doctor, metadata and logical database selection work without external CLI binaries', async () => {
  const doctor = (await invoke(['doctor'])).data;
  assert.equal(doctor.ok, true); assert.match(doctor.driver_version, /^6\./);
  assert.equal((await invoke(['auth', 'status', '--verify'])).data.verified, true);
  assert.equal((await invoke(['db', 'size'])).data.count, 9);
  assert.equal((await invoke(['db', 'size', '--database', '1'])).data.count, 0);
  assert.ok((await invoke(['db', 'list'])).data.items.some(item => item.database === 0));
  assert.match((await invoke(['server', 'info'])).data.info.redis_version, /^\d+\./);
  assert.equal((await invoke(['key', 'inspect', 'list:queue'])).data.type, 'list');
  assert.equal((await invoke(['key', 'inspect', 'list:queue'])).data.length, 3);
  assert.equal((await invoke(['key', 'exists', 'absent'])).data.exists, false);
  assert.equal((await invoke(['key', 'ttl', 'absent'])).data.ttl_ms, -2);
  const serialized = fs.readFileSync(path.join(directory, 'config', 'config.json'), 'utf8');
  assert.ok(!serialized.includes(password));
});
test('SCAN/HSCAN/SSCAN preserve complete pages and resume using lossless cursor strings', async () => {
  let cursor = '0'; const keys = [];
  do {
    const page = (await invoke(['key', 'scan', '--pattern', 'string:*', '--count', '1', '--cursor', cursor])).data;
    keys.push(...page.items.map(item => item.key)); cursor = page.cursor;
    assert.equal(page.has_more, cursor !== '0');
  } while (cursor !== '0');
  assert.deepEqual([...new Set(keys)].sort(), ['string:binary', 'string:empty', 'string:hello']);
  const compact = (await invoke(['hash', 'scan', 'hash:user', '--count', '1'])).data;
  assert.equal(compact.items.length, 26, 'compact HSCAN returns more than COUNT; never truncate it');
  assert.ok(compact.items.some(item => item.field === '__proto__' && item.value === 'ordinary-field'));
  assert.equal((await invoke(['set', 'scan', 'set:tags', '--count', '1'])).data.items.length, 3);
  const nd = await invoke(['key', 'scan', '--pattern', 'no-such-key:*', '--format', 'ndjson']);
  assert.equal(nd.stdout, '');
});
test('string ranges, empty/missing values, binary keys and bytes remain lossless', async () => {
  const initial = (await invoke(['string', 'get', 'string:hello', '--bytes', '6'])).data;
  assert.equal(initial.value, '中文'); assert.equal(initial.next, 6);
  assert.equal((await invoke(['string', 'get', 'string:hello', '--offset', '6'])).data.value, ' hello');
  assert.equal((await invoke(['string', 'get', 'string:empty'])).data.value, '');
  assert.equal((await invoke(['string', 'get', 'absent'])).data.value, null);
  assert.deepEqual((await invoke(['string', 'get', 'string:binary'])).data.value, { $base64: '/wD+' });
  assert.deepEqual((await invoke(['string', 'get', 'string:hello', '--bytes', '1'])).data.value, { $base64: Buffer.from('中文').subarray(0, 1).toString('base64') });
  assert.equal((await invoke(['string', 'get', '/wE=', '--key-base64'])).data.value, 'binary-key-value');
  assert.ok((await invoke(['key', 'scan'])).data.items.some(item => typeof item.key === 'object' && item.key.$base64 === '/wE='));
});
test('hash, list, sorted set and stream reads have correct values and resumable pages', async () => {
  assert.equal((await invoke(['hash', 'get', 'hash:user', '--field', 'field1'])).data.value, 'value1');
  assert.equal((await invoke(['hash', 'get', 'hash:user', '--field', 'absent'])).data.value, null);
  const list = (await invoke(['list', 'range', 'list:queue', '--limit', '2'])).data;
  assert.deepEqual(list.items.map(item => item.value), ['a', 'b']); assert.equal(list.next, 2);
  assert.deepEqual((await invoke(['list', 'range', 'list:queue', '--skip', '2'])).data.items.map(item => item.value), ['c']);
  const rank = (await invoke(['zset', 'range', 'zset:rank', '--reverse', '--limit', '1'])).data;
  assert.deepEqual(rank.items, [{ value: 'c', score: '3' }]); assert.equal(rank.next, 1);
  const stream = (await invoke(['stream', 'range', 'stream:events', '--limit', '2'])).data;
  assert.equal(stream.items.length, 2); assert.equal(stream.has_more, true);
  const rest = (await invoke(['stream', 'range', 'stream:events', '--after', stream.next])).data;
  assert.equal(rest.items.length, 1); assert.notEqual(rest.items[0].id, stream.next);
});
test('all data mutation routes are gated and fixed commands change only the intended data', async () => {
  const set = ['string', 'set', 'scratch', '--value', 'data', '--expires', '60'];
  assert.equal((await invoke(set, { success: false })).error.code, 'WRITE_BLOCKED');
  assert.equal((await invoke([...set, '--dry-run'])).data.dry_run, true);
  assert.equal(await client.exists('scratch'), 0);
  assert.equal((await invoke([...set, '--allow-writes'])).data.applied, true);
  assert.equal((await invoke(['string', 'set', 'scratch', '--value', 'changed', '--nx', '--allow-writes'])).data.applied, false);
  await invoke(['string', 'set', 'scratch', '--value', 'changed', '--xx', '--keep-ttl', '--allow-writes']);
  assert.ok((await invoke(['key', 'ttl', 'scratch'])).data.ttl_ms > 0);
  assert.equal((await invoke(['key', 'persist', 'scratch', '--allow-writes'])).data.applied, true);
  assert.equal((await invoke(['key', 'ttl', 'scratch'])).data.ttl_ms, -1);
  await invoke(['key', 'expire', 'scratch', '--seconds', '60', '--allow-writes']);
  const binaryFile = path.join(directory, 'value.bin'); fs.writeFileSync(binaryFile, Buffer.from([0xff, 0x00]));
  await invoke(['string', 'set', 'scratch:binary', '--value-file', binaryFile, '--allow-writes']);
  assert.deepEqual((await invoke(['string', 'get', 'scratch:binary'])).data.value, { $base64: '/wA=' });
  await invoke(['string', 'set', 'scratch:counter', '--value', '9223372036854775806', '--allow-writes']);
  assert.equal((await invoke(['string', 'increment', 'scratch:counter', '--allow-writes'])).data.value, '9223372036854775807');
  assert.equal((await invoke(['hash', 'set', 'scratch:hash', '--entries', '{"a":"b","c":"d"}', '--allow-writes'])).data.added, 2);
  assert.equal((await invoke(['hash', 'delete', 'scratch:hash', '--members', '["a"]', '--allow-writes'])).data.deleted, 1);
  assert.equal((await invoke(['list', 'push', 'scratch:list', '--values', '["a","b"]', '--side', 'left', '--allow-writes'])).data.length, 2);
  assert.equal((await invoke(['set', 'add', 'scratch:set', '--members', '["a","b"]', '--allow-writes'])).data.added, 2);
  assert.equal((await invoke(['set', 'remove', 'scratch:set', '--members', '["a"]', '--allow-writes'])).data.removed, 1);
  assert.equal((await invoke(['zset', 'add', 'scratch:zset', '--entries', '[{"value":"a","score":"1.25"}]', '--allow-writes'])).data.added, 1);
  assert.equal((await invoke(['zset', 'remove', 'scratch:zset', '--members', '["a"]', '--allow-writes'])).data.removed, 1);
  const id = (await invoke(['stream', 'add', 'scratch:stream', '--entries', '{"a":"b"}', '--allow-writes'])).data.id;
  assert.equal((await invoke(['stream', 'delete', 'scratch:stream', '--ids', JSON.stringify([id]), '--allow-writes'])).data.deleted, 1);
  assert.equal((await invoke(['key', 'delete', 'scratch', '--allow-writes', '--read-only'], { success: false })).error.code, 'READ_ONLY');
  assert.equal((await invoke(['key', 'delete', 'scratch', '--allow-writes'])).data.deleted, 1);
  assert.equal(await client.exists('string:hello'), 1);
});
test('server auth/ACL/type failures are structured and sanitized, and oversized hash values are rejected', async () => {
  const bad = await invoke(['ping'], { success: false, env: { REDIS_CLI_PASSWORD: 'wrong-test-password' } });
  assert.equal(bad.status, 4); assert.equal(bad.error.code, 'AUTHENTICATION_FAILED');
  const reader = { REDIS_CLI_USERNAME: 'reader', REDIS_CLI_PASSWORD: password };
  assert.equal((await invoke(['string', 'get', 'string:hello'], { env: reader })).data.value, '中文 hello');
  assert.equal((await invoke(['string', 'set', 'string:hello', '--value', 'blocked', '--allow-writes'], { env: reader, success: false })).error.code, 'PERMISSION_DENIED');
  assert.equal((await invoke(['string', 'get', 'hash:user'], { success: false })).error.code, 'WRONG_TYPE');
  await client.hSet('scratch:large', 'field', 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await invoke(['hash', 'get', 'scratch:large', '--field', 'field'], { success: false })).error.code, 'OUTPUT_TOO_LARGE');
  assert.ok(!bad.stderr.includes('wrong-test-password'));
  assert.equal((await invoke(['ping', '--database', '65535'], { success: false })).error.code, 'INVALID_DATABASE');
});
test('real stalled connections honor the deadline and writes report unknown outcomes without retries', async () => {
  const sockets = new Set();
  let connections = 0;
  const stalled = net.createServer(socket => { connections++; sockets.add(socket); socket.on('data', () => {}); socket.on('close', () => sockets.delete(socket)); });
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening');
  try {
    await invoke(['config', 'set-context', 'test', '--port', String(stalled.address().port)]);
    const result = await invoke(['string', 'increment', 'never-sent', '--timeout', '1000', '--allow-writes'], { success: false, env: { REDIS_CLI_PASSWORD: password } });
    assert.equal(result.status, 8); assert.equal(result.error.code, 'PROCESS_TIMEOUT');
    assert.equal(result.error.retryable, false); assert.match(result.error.hint, /unknown or partial/);
    assert.equal(connections, 1, 'no reconnect after the stalled handshake');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => stalled.close(resolve));
    await invoke(['config', 'set-context', 'test', '--port', String(port)]);
  }
});
test('logout preserves the auth marker and never silently falls back to unauthenticated access', async () => {
  await invoke(['auth', 'logout']);
  assert.equal((await invoke(['ping'], { success: false })).error.code, 'CREDENTIAL_NOT_FOUND');
});
