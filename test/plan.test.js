import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/cli.js';
import { planOperation } from '../src/plan.js';

test('all write routes require invocation authorization and respect the read-only lock', () => {
  const cases = [
    ['key delete', {}], ['key expire', { seconds: '20' }], ['key persist', {}],
    ['string set', { value: 'data' }], ['string increment', {}],
    ['hash set', { entries: '{"name":"value"}' }], ['hash delete', { members: '["name"]' }],
    ['list push', { values: '["item"]' }], ['set add', { members: '["a"]' }], ['set remove', { members: '["a"]' }],
    ['zset add', { entries: '[{"value":"a","score":"1.5"}]' }], ['zset remove', { members: '["a"]' }],
    ['stream add', { entries: '{"name":"value"}' }], ['stream delete', { ids: '["1-0"]' }]
  ];
  for (const [command, options] of cases) {
    assert.throws(() => planOperation(command, ['literal:*'], options, {}), { code: 'WRITE_BLOCKED' });
    assert.equal(planOperation(command, ['literal:*'], { ...options, 'dry-run': true }, {}).key, 'literal:*');
    assert.equal(planOperation(command, ['literal:*'], { ...options, 'allow-writes': true }, {}).write, true);
    assert.throws(() => planOperation(command, ['literal:*'], { ...options, 'allow-writes': true }, { REDIS_CLI_READ_ONLY: '1' }), { code: 'READ_ONLY' });
    assert.throws(() => planOperation(command, ['literal:*'], { ...options, 'allow-writes': true, 'read-only': true }, {}), { code: 'READ_ONLY' });
  }
});

test('scan cursors and int64 increments never pass through lossy Number conversion', () => {
  assert.equal(planOperation('key scan', [], { cursor: '18446744073709551615' }).cursor, '18446744073709551615');
  assert.throws(() => planOperation('key scan', [], { cursor: '18446744073709551616' }));
  assert.throws(() => planOperation('key scan', [], { count: '1001' }));
  assert.equal(planOperation('string increment', ['counter'], { by: '9223372036854775807', 'dry-run': true }).by, '9223372036854775807');
  assert.throws(() => planOperation('string increment', ['counter'], { by: '9223372036854775808', 'dry-run': true }));
  assert.throws(() => planOperation('key expire', ['key'], { seconds: '0', 'dry-run': true }));
});

test('reads are bounded and raw/server administration commands and secret flags are unavailable', () => {
  assert.equal(planOperation('list range', ['queue'], {}).limit, 20);
  assert.equal(planOperation('string get', ['key'], {}).bytes, 65536);
  assert.throws(() => planOperation('string get', ['key'], { bytes: '1048577' }));
  assert.throws(() => planOperation('list range', ['key'], { limit: '1001' }));
  for (const args of [['FLUSHALL'], ['raw', 'GET', 'key'], ['eval', 'script'], ['KEYS', '*'], ['CONFIG', 'GET', '*'], ['ACL', 'LIST'], ['config', 'init', '--password', 'secret'], ['config', 'init', '--uri', 'redis://:secret@host'], ['string', 'get', 'key', '--vlaue', 'secret'], ['key', 'scan', '--count', '2', '--count', '3'], ['string', 'set', 'key', '--value-file', '-', '--entries-file', '-']]) assert.throws(() => parse(args));
});

test('write shapes, SET semantics and canonical binary key encoding are validated', () => {
  const plan = options => planOperation('string set', ['key'], { ...options, 'dry-run': true });
  assert.throws(() => plan({}));
  assert.throws(() => plan({ value: 'x', 'value-file': 'file' }));
  assert.throws(() => plan({ value: 'x', nx: true, xx: true }));
  assert.throws(() => plan({ value: 'x', expires: '3', 'keep-ttl': true }));
  assert.deepEqual(plan({ value: '中文' }).value, { $base64: Buffer.from('中文').toString('base64') });
  assert.throws(() => planOperation('hash set', ['key'], { entries: '{"n":1}', 'dry-run': true }));
  assert.throws(() => planOperation('set add', ['key'], { members: '[]', 'dry-run': true }));
  assert.throws(() => planOperation('zset add', ['key'], { entries: '[{"value":"a","score":"NaN"}]', 'dry-run': true }));
  assert.deepEqual(planOperation('key inspect', ['/w=='], { 'key-base64': true }).key, { $base64: '/w==' });
  assert.throws(() => planOperation('key inspect', ['not-base64'], { 'key-base64': true }));
});
