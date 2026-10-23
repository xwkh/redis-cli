import fs from 'node:fs';
import { jsonInput } from './io.js';
import { integer } from './config.js';
import { CLIError, usage } from './errors.js';

const writes = new Set('key delete|key expire|key persist|string set|string increment|hash set|hash delete|list push|set add|set remove|zset add|zset remove|stream add|stream delete'.split('|'));
const scanCommands = new Set(['key scan', 'hash scan', 'set scan']);
const pageCommands = new Set(['list range', 'zset range', 'stream range']);
const stringArray = (value, label) => {
  if (!Array.isArray(value) || !value.length || value.length > 1000 || value.some(item => typeof item !== 'string' || Buffer.byteLength(item) > 1024 * 1024)) throw usage(`${label} must be an array of 1–1000 strings, each at most 1 MiB.`);
  return value;
};
const entries = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 1000 || Object.entries(value).some(([key, item]) => !key || typeof item !== 'string')) throw usage('--entries must be a nonempty JSON object of string field values (at most 1000 fields).');
  return value;
};
export const isBase64 = value => typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;

export function planOperation(command, args, options, env = process.env) {
  const operation = { command, write: writes.has(command) };
  if (args[0] !== undefined) {
    if (!args[0] || Buffer.byteLength(args[0]) > 4096) throw usage('Key names must contain 1–4096 bytes.');
    if (options['key-base64'] && !isBase64(args[0])) throw usage('--key-base64 requires a canonical base64 key.');
    operation.key = options['key-base64'] ? { $base64: args[0] } : args[0];
  }
  if (scanCommands.has(command)) {
    const cursor = options.cursor ?? '0';
    if (!/^(0|[1-9]\d{0,19})$/.test(cursor) || BigInt(cursor) > 18446744073709551615n) throw usage('--cursor must be a decimal unsigned 64-bit cursor.');
    operation.cursor = cursor;
    operation.count = integer(options.count ?? 100, '--count', 1, 1000);
    if (options.pattern !== undefined) {
      if (Buffer.byteLength(options.pattern) > 4096) throw usage('--pattern must be at most 4096 bytes.');
      operation.pattern = options.pattern;
    }
    if (options.type !== undefined) {
      if (!['string', 'hash', 'list', 'set', 'zset', 'stream'].includes(options.type)) throw usage('Unsupported Redis key type.');
      operation.type = options.type;
    }
  }
  if (pageCommands.has(command)) {
    operation.limit = integer(options.limit ?? 20, '--limit', 1, 1000);
    if (command !== 'stream range') operation.skip = integer(options.skip ?? 0, '--skip', 0, 1000000);
  }
  if (command === 'server info') {
    operation.section = options.section || 'server';
    if (!['server', 'clients', 'memory', 'persistence', 'stats', 'replication', 'cpu', 'keyspace'].includes(operation.section)) throw usage('Unsupported INFO section.');
  }
  if (command === 'string get') {
    operation.offset = integer(options.offset ?? 0, '--offset', 0, 536870911);
    operation.bytes = integer(options.bytes ?? 65536, '--bytes', 1, 1024 * 1024);
  }
  if (command === 'string set') {
    if ((options.value === undefined) === (options['value-file'] === undefined)) throw usage('Use exactly one of --value or --value-file.');
    let buffer;
    try { buffer = options['value-file'] !== undefined ? fs.readFileSync(options['value-file'] === '-' ? 0 : options['value-file']) : Buffer.from(options.value); }
    catch { throw usage('Cannot read --value-file.', 'INPUT_FILE_UNREADABLE'); }
    if (buffer.length > 8 * 1024 * 1024) throw usage('String input must be at most 8 MiB.');
    operation.value = { $base64: buffer.toString('base64') };
    if (options.nx && options.xx) throw usage('--nx and --xx are mutually exclusive.');
    if (options['keep-ttl'] && options.expires !== undefined) throw usage('--keep-ttl and --expires are mutually exclusive.');
    operation.nx = !!options.nx; operation.xx = !!options.xx; operation.keep_ttl = !!options['keep-ttl'];
    if (options.expires !== undefined) operation.expires = integer(options.expires, '--expires', 1, 2147483647);
  }
  if (command === 'string increment') {
    operation.by = options.by ?? '1';
    if (!/^-?(0|[1-9]\d{0,18})$/.test(operation.by) || BigInt(operation.by) < -9223372036854775808n || BigInt(operation.by) > 9223372036854775807n) throw usage('--by must be a signed 64-bit decimal integer.');
  }
  if (command === 'key expire') operation.seconds = integer(options.seconds, '--seconds', 1, 2147483647);
  if (command === 'hash get') {
    if (options.field === undefined || !options.field || Buffer.byteLength(options.field) > 4096) throw usage('--field requires 1–4096 bytes.');
    operation.field = options.field;
  }
  if (['hash set', 'stream add'].includes(command)) operation.entries = entries(jsonInput(options, 'entries', { required: true }));
  if (['hash delete', 'set add', 'set remove', 'zset remove'].includes(command)) operation.members = stringArray(jsonInput(options, 'members', { required: true }), '--members');
  if (command === 'list push') {
    operation.values = stringArray(jsonInput(options, 'values', { required: true }), '--values');
    operation.side = options.side ?? 'right';
    if (!['left', 'right'].includes(operation.side)) throw usage('--side must be left or right.');
  }
  if (command === 'zset range') operation.reverse = !!options.reverse;
  if (command === 'zset add') {
    const values = jsonInput(options, 'entries', { required: true });
    if (!Array.isArray(values) || !values.length || values.length > 1000 || values.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'score,value' || typeof entry.value !== 'string' || !['string', 'number'].includes(typeof entry.score) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(entry.score)) || !Number.isFinite(Number(entry.score)))) throw usage('--entries must be 1–1000 {value:string, score:finite number or decimal string} objects.');
    operation.entries = values;
  }
  if (command === 'stream range') {
    if (options.after !== undefined && !/^\d{1,20}-\d{1,20}$/.test(options.after)) throw usage('--after must be a stream entry ID.');
    operation.after = options.after;
  }
  if (command === 'stream delete') {
    operation.ids = stringArray(jsonInput(options, 'ids', { required: true }), '--ids');
    if (operation.ids.some(id => !/^\d{1,20}-\d{1,20}$/.test(id))) throw usage('--ids requires stream entry IDs.');
  }
  if (operation.write && !options['dry-run']) {
    if (options['read-only'] || ['1', 'true'].includes(env.REDIS_CLI_READ_ONLY)) throw new CLIError('permission', 'READ_ONLY', 'This invocation is locked to read-only mode.', 'Remove the lock only for user-authorized changes.');
    if (!options['allow-writes']) throw new CLIError('permission', 'WRITE_BLOCKED', 'Writes require --allow-writes.', 'Preview the authorized change with --dry-run.');
  }
  return operation;
}
