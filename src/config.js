import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { atomicJSON, readJSON } from './io.js';
import { CLIError, usage } from './errors.js';

export const defaults = { host: '127.0.0.1', port: 6379, database: 0, tls: false };
const contextKeys = new Set([...Object.keys(defaults), 'tls_ca_file', 'tls_certificate_file', 'tls_key_file', 'credential_backend']);
export const contextFlags = { host: 'host', port: 'port', database: 'database', tls: 'tls', 'tls-ca-file': 'tls_ca_file', 'tls-certificate-file': 'tls_certificate_file', 'tls-key-file': 'tls_key_file' };
export const configDirectory = (options = {}, env = process.env, home = os.homedir()) => path.resolve(options.config || env.REDIS_CLI_CONFIG_DIR || path.join(home, '.xwkh', 'redis'));

export function validName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name || '')) throw usage('Context name must use 1–64 letters, digits, dots, underscores or hyphens.');
  return name;
}

export function integer(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) throw usage(`${label} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw usage(`${label} is outside its supported range.`);
  return result;
}

export function validateContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage('Context must be an object.');
  for (const key of Object.keys(value)) if (!contextKeys.has(key)) throw usage('Unsupported context field. Store passwords separately.');
  const c = { ...defaults, ...value };
  if (typeof c.host !== 'string' || (!isIP(c.host) && !/^(?=.{1,253}$)[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.?$/.test(c.host))) throw usage('Host must be a hostname or IP, without a URI, port or credentials.');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw usage('Port must be between 1 and 65535.');
  if (!Number.isInteger(c.database) || c.database < 0 || c.database > 65535) throw usage('Database must be an integer from 0 to 65535.');
  if (typeof c.tls !== 'boolean') throw usage('TLS must be boolean.');
  for (const field of ['tls_ca_file', 'tls_certificate_file', 'tls_key_file']) if (c[field] !== undefined && (typeof c[field] !== 'string' || !c[field] || c[field].includes('\0'))) throw usage('TLS paths must be nonempty strings.');
  if ((c.tls_ca_file || c.tls_certificate_file || c.tls_key_file) && !c.tls) throw usage('TLS certificate options require --tls.');
  if (!!c.tls_certificate_file !== !!c.tls_key_file) throw usage('Client TLS certificate and key must be specified together.');
  if (c.credential_backend !== undefined && !['keychain', 'file', 'none'].includes(c.credential_backend)) throw usage('Unsupported credential backend.');
  return c;
}

export function loadConfig(directory) {
  const config = readJSON(path.join(directory, 'config.json'), { version: 1, current_context: null, contexts: {} });
  try {
    if (config?.version !== 1 || !config.contexts || typeof config.contexts !== 'object' || Array.isArray(config.contexts)) throw Error();
    for (const [name, context] of Object.entries(config.contexts)) { validName(name); validateContext(context); }
    if (config.current_context !== null && !Object.hasOwn(config.contexts, config.current_context)) throw Error();
  } catch { throw new CLIError('config', 'INVALID_CONFIG', 'Invalid Redis configuration.', 'Check the local configuration or run redis-cli config init. Do not paste passwords into chat.'); }
  return config;
}
export const saveConfig = (directory, config) => atomicJSON(path.join(directory, 'config.json'), config);

export function contextFromFlags(options, previous = {}) {
  const value = { ...previous };
  for (const [flag, field] of Object.entries(contextFlags)) if (options[flag] !== undefined) value[field] = ['port', 'database'].includes(flag) ? integer(options[flag], `--${flag}`, field === 'port' ? 1 : 0, 65535) : options[flag];
  return validateContext(value);
}

export function selectContext(directory, options = {}, env = process.env) {
  const config = loadConfig(directory);
  const name = options['use-context'] || env.REDIS_CLI_CONTEXT || config.current_context;
  if (!name || !Object.hasOwn(config.contexts, name)) throw new CLIError('config', 'CONTEXT_NOT_FOUND', 'No matching Redis context is configured.', 'Configure a connection in your own terminal.', ['redis-cli config init', 'redis-cli config contexts']);
  const stored = validateContext(config.contexts[name]);
  const context = contextFromFlags(options.database !== undefined ? { database: options.database } : {}, stored);
  return { name, stored, context, config };
}
