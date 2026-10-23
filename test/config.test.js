import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configDirectory, validateContext, saveConfig, loadConfig, selectContext } from '../src/config.js';
import { CredentialStore, accountKey, resolveCredential } from '../src/credentials.js';
import { emit } from '../src/io.js';

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-cli-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('configuration uses the xwkh namespace, private atomic files and excludes credentials', t => {
  const directory = temporary(t), context = validateContext({});
  assert.equal(configDirectory({}, {}, '/tmp/home'), '/tmp/home/.xwkh/redis');
  assert.equal(configDirectory({ config: directory }, { REDIS_CLI_CONFIG_DIR: '/ignored' }), directory);
  saveConfig(directory, { version: 1, current_context: 'dev', contexts: { dev: context } });
  assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(selectContext(directory, { database: '2' }).context.database, 2);
  assert.equal(loadConfig(directory).contexts.dev.database, 0);
  for (const value of [{ password: 'secret' }, { username: 'name' }, { host: 'redis://u:p@host' }, { port: 0 }, { database: -1 }, { tls_ca_file: '/ca' }]) assert.throws(() => validateContext(value));
  assert.equal(validateContext({ host: '::1' }).host, '::1');
});
test('password-only credentials are separate, bound to endpoints, and file permissions are enforced', t => {
  const directory = temporary(t), context = validateContext({});
  const store = new CredentialStore(directory, { platform: 'linux' });
  const key = accountKey(directory, 'dev', context), credential = { username: '', password: 'private-test-password' };
  assert.equal(store.save(key, credential), 'file');
  assert.deepEqual(store.load(key, 'file'), credential);
  assert.equal(accountKey(directory, 'dev', { ...context, database: 2 }), key);
  for (const changes of [{ host: 'other' }, { port: 6380 }, { tls: true }, { tls: true, tls_ca_file: '/ca' }]) assert.notEqual(accountKey(directory, 'dev', { ...context, ...changes }), key);
  fs.chmodSync(store.file(key), 0o644);
  assert.throws(() => store.load(key, 'file'), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
  fs.rmSync(store.file(key)); fs.symlinkSync('/etc/hosts', store.file(key));
  assert.throws(() => store.load(key, 'file'), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
});
test('keychain setup never puts the password in argv and never silently falls back after denial', () => {
  const calls = [], credential = { username: '', password: 'secret-test-value' };
  const store = new CredentialStore('/unused', { platform: 'darwin', run: (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout: '', stderr: '' }; } });
  assert.equal(store.save('a'.repeat(64), credential), 'keychain');
  assert.equal(calls[1].file, '/usr/bin/security');
  assert.deepEqual(calls[1].args, ['-i']);
  assert.ok(!JSON.stringify(calls.map(call => call.args)).includes(credential.password));
  assert.ok(calls[1].options.input.includes(Buffer.from(JSON.stringify(credential)).toString('base64')));
  const denied = new CredentialStore('/unused', { platform: 'darwin', run: (_, args) => ({ status: args[0] === '-i' ? 1 : 0, stderr: 'denied' }) });
  assert.throws(() => denied.save('a'.repeat(64), credential), { code: 'CREDENTIAL_STORE_INACCESSIBLE' });
});
test('environment auth supports a password alone, and logout never downgrades to anonymous access', () => {
  const store = { load: () => null }, context = validateContext({ credential_backend: 'file' });
  assert.deepEqual(resolveCredential(store, '/dir', 'dev', context, { REDIS_CLI_PASSWORD: 'secret' }), { username: '', password: 'secret' });
  assert.deepEqual(resolveCredential(store, '/dir', 'dev', context, { REDIS_CLI_USERNAME: 'reader', REDIS_CLI_PASSWORD: 'secret' }), { username: 'reader', password: 'secret' });
  assert.throws(() => resolveCredential(store, '/dir', 'dev', context, { REDIS_CLI_USERNAME: 'reader' }), { code: 'INCOMPLETE_ENV_CREDENTIALS' });
  assert.throws(() => resolveCredential(store, '/dir', 'dev', context, {}), { code: 'CREDENTIAL_NOT_FOUND' });
});
test('offline preview works without credentials or an executable PATH and secret flags never echo values', t => {
  const directory = temporary(t), cli = path.resolve('bin/redis-cli.js');
  const invoke = args => spawnSync(process.execPath, [cli, '--config', directory, ...args], { encoding: 'utf8', env: { ...process.env, PATH: directory } });
  assert.equal(invoke(['config', 'set-context', 'dev']).status, 0);
  const preview = invoke(['string', 'set', 'demo', '--value', 'hello', '--dry-run']);
  assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).dry_run, true);
  const bad = invoke(['config', 'init', '--password', 'DO_NOT_ECHO']);
  assert.equal(bad.status, 2); assert.ok(!bad.stderr.includes('DO_NOT_ECHO'));
});
test('JSON/NDJSON projections preserve pagination without prototype pollution', () => {
  let stdout = '', stderr = '';
  const out = { write: value => stdout += value }, err = { write: value => stderr += value };
  emit({ items: [{ key: 'hello', other: 'ignored' }], has_more: true, next: '123' }, { format: 'ndjson', fields: 'key' }, out, err);
  assert.deepEqual(JSON.parse(stdout), { key: 'hello' });
  assert.equal(JSON.parse(stderr)._notice.pagination.next, '123');
  emit(JSON.parse('{"__proto__":{"polluted":true}}'), { fields: '__proto__.polluted' }, out, err);
  assert.equal({}.polluted, undefined);
});
