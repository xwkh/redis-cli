import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { createClient, RESP_TYPES } from '@redis/client';
import { connectionOptions } from './connection.js';

const prefix = '__REDIS_CLI_RESPONSE__';
const label = code => Object.assign(new Error(), { safeCode: code });
const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
const bytes = value => typeof value === 'string' ? value : Buffer.from(value.$base64, 'base64');
const numeric = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : { $numberLong: String(value) };
};
function serialize(value) {
  if (Buffer.isBuffer(value)) return isUtf8(value) ? value.toString('utf8') : { $base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
  return value;
}
function safeCode(error) {
  if (error.safeCode) return error.safeCode;
  const message = String(error.message || '');
  for (const code of ['WRONGPASS', 'NOAUTH', 'NOPERM', 'READONLY', 'WRONGTYPE', 'MOVED', 'ASK']) if (message.startsWith(`${code} `)) return code;
  if (/^ERR AUTH /i.test(message)) return 'AUTH_FAILED';
  if (/^ERR (DB index|invalid DB index)/i.test(message)) return 'INVALID_DATABASE';
  if (/Timeout/i.test(error.name) || error.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (/^(ECONN|EHOST|ENET|ENOTFOUND|EAI_|CERT_|ERR_TLS|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO)/.test(String(error.code)) || /Socket|Connection|Disconnect/i.test(error.name)) return 'NETWORK';
  return 'ERR';
}
const parseInfo = buffer => Object.fromEntries(text(buffer).split('\r\n').filter(line => line && !line.startsWith('#') && line.includes(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
const pairs = (values, first, second) => {
  const items = [];
  for (let i = 0; i < values.length; i += 2) items.push({ [first]: values[i], [second]: values[i + 1] });
  return items;
};

let client;
try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const op = request.operation;
  let options;
  try { options = connectionOptions(request.context, request.credential, request.timeout); }
  catch { throw label('TLS_CONFIG'); }
  client = createClient({ ...options, commandOptions: { typeMapping: { [RESP_TYPES.NUMBER]: String, [RESP_TYPES.BLOB_STRING]: Buffer } } });
  client.on('error', () => {}); // Do not log messages that may contain credentials or user data.
  await client.connect();
  const send = args => client.sendCommand(args.map(value => typeof value === 'number' ? String(value) : value));
  const key = op.key !== undefined ? bytes(op.key) : null;
  const page = items => ({ items: items.slice(0, op.limit), has_more: items.length > op.limit, ...(items.length > op.limit ? { next: op.skip + op.limit } : {}) });
  let result;
  switch (op.command) {
    case 'ping': case 'doctor': case 'auth login': case 'auth status':
      await send(['PING']); result = { ok: true, database: request.context.database }; break;
    case 'server info': result = { section: op.section, info: parseInfo(await send(['INFO', op.section])) }; break;
    case 'db list': result = { items: Object.entries(parseInfo(await send(['INFO', 'keyspace']))).filter(([name]) => /^db\d+$/.test(name)).map(([name, stats]) => ({ database: Number(name.slice(2)), ...Object.fromEntries(stats.split(',').map(item => item.split('='))) })), has_more: false, scope: 'nonempty databases reported by INFO keyspace; ACL visibility is not inferred' }; break;
    case 'db size': result = { database: request.context.database, count: numeric(await send(['DBSIZE'])) }; break;
    case 'key scan': case 'hash scan': case 'set scan': {
      const args = op.command === 'key scan' ? ['SCAN', op.cursor] : [op.command === 'hash scan' ? 'HSCAN' : 'SSCAN', key, op.cursor];
      if (op.pattern !== undefined) args.push('MATCH', op.pattern);
      args.push('COUNT', op.count);
      if (op.type) args.push('TYPE', op.type);
      const [cursor, values] = await send(args);
      const next = text(cursor);
      const items = op.command === 'hash scan' ? pairs(values, 'field', 'value') : values.map(value => ({ [op.command === 'key scan' ? 'key' : 'value']: value }));
      // COUNT is not a limit: truncating here would lose elements permanently.
      result = { items, cursor: next, has_more: next !== '0', ...(next !== '0' ? { next } : {}) }; break;
    }
    case 'key exists': result = { key: op.key, exists: (await send(['EXISTS', key])) !== '0' }; break;
    case 'key ttl': result = { key: op.key, ttl_ms: numeric(await send(['PTTL', key])) }; break;
    case 'key inspect': {
      const type = text(await send(['TYPE', key]));
      const lengthCommand = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' }[type];
      result = { key: op.key, type, exists: type !== 'none', ttl_ms: numeric(await send(['PTTL', key])), ...(lengthCommand ? { length: numeric(await send([lengthCommand, key])) } : {}) }; break;
    }
    case 'string get': {
      const type = text(await send(['TYPE', key]));
      if (type !== 'none' && type !== 'string') throw label('WRONGTYPE');
      const value = type === 'none' ? null : await send(['GETRANGE', key, op.offset, op.offset + op.bytes - 1]);
      const total = Number(await send(['STRLEN', key]));
      const next = op.offset + (value?.length || 0), more = (value?.length || 0) > 0 && next < total;
      result = { key: op.key, exists: type !== 'none', value, offset: op.offset, bytes: value?.length ?? 0, total_bytes: total, has_more: more, ...(more ? { next } : {}) }; break;
    }
    case 'string set': {
      const args = ['SET', key, bytes(op.value)];
      if (op.nx) args.push('NX'); if (op.xx) args.push('XX');
      if (op.keep_ttl) args.push('KEEPTTL'); if (op.expires !== undefined) args.push('EX', op.expires);
      result = { key: op.key, applied: (await send(args)) !== null }; break;
    }
    case 'string increment': result = { key: op.key, value: await send(['INCRBY', key, op.by]) }; break;
    case 'key delete': result = { deleted: numeric(await send(['DEL', key])) }; break;
    case 'key expire': result = { applied: (await send(['EXPIRE', key, op.seconds])) !== '0' }; break;
    case 'key persist': result = { applied: (await send(['PERSIST', key])) !== '0' }; break;
    case 'hash get': {
      if (Number(await send(['HSTRLEN', key, op.field])) > 1024 * 1024) throw label('FIELD_TOO_LARGE');
      const value = await send(['HGET', key, op.field]);
      result = { key: op.key, field: op.field, value, exists: value !== null }; break;
    }
    case 'hash set': result = { added: numeric(await send(['HSET', key, ...Object.entries(op.entries).flat()])) }; break;
    case 'hash delete': result = { deleted: numeric(await send(['HDEL', key, ...op.members])) }; break;
    case 'list range': result = page((await send(['LRANGE', key, op.skip, op.skip + op.limit])).map((value, i) => ({ index: op.skip + i, value }))); break;
    case 'list push': result = { length: numeric(await send([op.side === 'left' ? 'LPUSH' : 'RPUSH', key, ...op.values])) }; break;
    case 'set add': result = { added: numeric(await send(['SADD', key, ...op.members])) }; break;
    case 'set remove': result = { removed: numeric(await send(['SREM', key, ...op.members])) }; break;
    case 'zset range': {
      const values = await send([op.reverse ? 'ZREVRANGE' : 'ZRANGE', key, op.skip, op.skip + op.limit, 'WITHSCORES']);
      result = page(pairs(values, 'value', 'score').map(item => ({ ...item, score: text(item.score) }))); break;
    }
    case 'zset add': result = { added: numeric(await send(['ZADD', key, ...op.entries.flatMap(entry => [String(entry.score), entry.value])])) }; break;
    case 'zset remove': result = { removed: numeric(await send(['ZREM', key, ...op.members])) }; break;
    case 'stream range': {
      const values = await send(['XRANGE', key, op.after ? `(${op.after}` : '-', '+', 'COUNT', op.limit + 1]);
      const items = values.slice(0, op.limit).map(([id, fields]) => ({ id: text(id), fields: pairs(fields, 'field', 'value') }));
      const more = values.length > op.limit;
      result = { items, has_more: more, ...(more ? { next: items.at(-1).id } : {}) }; break;
    }
    case 'stream add': result = { id: text(await send(['XADD', key, '*', ...Object.entries(op.entries).flat()])) }; break;
    case 'stream delete': result = { deleted: numeric(await send(['XDEL', key, ...op.ids])) }; break;
    default: throw label('UNSUPPORTED');
  }
  const output = JSON.stringify({ ok: true, result: serialize(result) });
  if (Buffer.byteLength(output) > 16 * 1024 * 1024 - prefix.length - 1) throw label('TOO_LARGE');
  process.stdout.write(`${prefix}${output}\n`);
} catch (error) {
  process.stdout.write(`${prefix}${JSON.stringify({ ok: false, error: { code: safeCode(error) } })}\n`);
} finally {
  try { if (client?.isOpen) client.destroy(); } catch { /* Response already sent. */ }
}
