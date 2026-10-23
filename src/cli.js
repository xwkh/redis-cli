import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { CLIError, usage, exits } from './errors.js';
import { configDirectory, loadConfig, saveConfig, selectContext, contextFromFlags, validName, integer, defaults } from './config.js';
import { accountKey, CredentialStore, resolveCredential } from './credentials.js';
import { emit } from './io.js';
import { specs, globals, help } from './specs.js';
import { planOperation } from './plan.js';
import { runRedis } from './runner.js';
import { promptFields } from './prompts.js';
import { manageSkill } from './skills.js';
import { driverVersion } from './connection.js';

export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export function parse(argv) {
  // First tokenize all known flags to locate commands without mistaking a flag
  // value for a noun. Then strictly parse only the selected command's options.
  const all = Object.assign({}, globals, ...Object.values(specs).map(s => s.options || {}));
  let preliminary;
  try { preliminary = parseArgs({ args: argv, options: all, allowPositionals: true, tokens: true }); }
  catch { throw usage('Unknown flag or missing flag value. Run redis-cli --help.', 'BAD_FLAG'); }
  const words = preliminary.positionals;
  if (preliminary.values.version) return { command: 'version', args: [], options: preliminary.values };
  let command = Object.hasOwn(specs, words[0]) ? words[0] : words.slice(0, 2).join(' ');
  if (preliminary.values.help || !words.length || (words.length === 1 && Object.keys(specs).some(k => k.startsWith(`${words[0]} `)))) {
    if (words.length && !Object.hasOwn(specs, command) && !Object.keys(specs).some(k => k.startsWith(`${words[0]} `))) throw usage('Unknown command.', 'UNKNOWN_COMMAND');
    return { help: help(Object.hasOwn(specs, command) ? command : words[0]) };
  }
  const spec = specs[command];
  if (!spec) throw usage('Unknown command. Run redis-cli --help.', 'UNKNOWN_COMMAND');
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { ...globals, ...spec.options }, allowPositionals: true, tokens: true }); }
  catch { throw usage('This flag is not supported by the selected command, or its value is missing.', 'BAD_FLAG'); }
  const flags = parsed.tokens.filter(t => t.kind === 'option').map(t => t.name);
  if (new Set(flags).size !== flags.length) throw usage('Repeated flags are not supported.', 'DUPLICATE_FLAG');
  const args = parsed.positionals.slice(command.split(' ').length);
  if (args.length !== spec.args) throw usage(`Expected: redis-cli ${command}${spec.operand ? ` ${spec.operand}` : ''}.`);
  if (parsed.values.format && !['json', 'ndjson'].includes(parsed.values.format)) throw usage('--format must be json or ndjson.');
  if (Object.entries(parsed.values).filter(([name, value]) => name.endsWith('-file') && value === '-').length > 1) throw usage('Only one JSON input may read stdin.');
  return { command, args, options: parsed.values };
}

async function credentialsFromUser(options) {
  if (process.env.REDIS_CLI_PASSWORD !== undefined || process.env.REDIS_CLI_USERNAME !== undefined) {
    if (!process.env.REDIS_CLI_PASSWORD) throw usage('REDIS_CLI_PASSWORD must be nonempty when supplying environment credentials.');
    return { username: options.username ?? process.env.REDIS_CLI_USERNAME ?? '', password: process.env.REDIS_CLI_PASSWORD };
  }
  const { password } = await promptFields([{ key: 'password', label: 'Redis password (hidden)', secret: true }]);
  if (!password) throw usage('A nonempty password is required for auth login. Configure a passwordless endpoint with config init instead.');
  return { username: options.username || '', password };
}

async function execute(command, args, options) {
  if (command === 'version') return { version, node: process.version, driver_version: driverVersion };
  if (command.startsWith('skill ')) return manageSkill(command.split(' ')[1], options, version);
  const directory = configDirectory(options);
  const store = new CredentialStore(directory);
  if (command === 'config contexts') {
    const config = loadConfig(directory);
    return { items: Object.entries(config.contexts).map(([name, context]) => ({ name, current: name === config.current_context, ...context })), has_more: false };
  }
  if (command === 'config init') {
    const name = validName(options.name || 'default');
    const config = loadConfig(directory);
    const previous = Object.hasOwn(config.contexts, name) ? config.contexts[name] : defaults;
    const answers = await promptFields([
      { key: 'host', label: 'Redis host/IP', default: previous.host },
      { key: 'port', label: 'Port', default: String(previous.port) },
      { key: 'password', label: 'Password (hidden; empty for no authentication)', secret: true }
    ]);
    const context = contextFromFlags({ ...options, host: answers.host, port: answers.port }, previous);
    context.credential_backend = answers.password ? store.save(accountKey(directory, name, context), { username: options.username || '', password: answers.password }, options['credential-store'] || 'auto') : 'none';
    Object.defineProperty(config.contexts, name, { value: context, enumerable: true, configurable: true, writable: true });
    config.current_context = name;
    saveConfig(directory, config);
    return { configured: true, directory, context: name, credential_backend: context.credential_backend, next_steps: ['redis-cli doctor'] };
  }
  if (command === 'config set-context') {
    const name = validName(args[0]);
    const config = loadConfig(directory);
    const context = contextFromFlags(options, Object.hasOwn(config.contexts, name) ? config.contexts[name] : {});
    Object.defineProperty(config.contexts, name, { value: context, enumerable: true, configurable: true, writable: true });
    config.current_context ??= name;
    saveConfig(directory, config);
    return { context: name, ...context, next_steps: ['redis-cli auth login'] };
  }
  if (command === 'config use-context' || command === 'config delete-context') {
    const name = validName(args[0]);
    const config = loadConfig(directory);
    if (!Object.hasOwn(config.contexts, name)) throw new CLIError('config', 'CONTEXT_NOT_FOUND', 'Context does not exist.', 'List configured contexts.', ['redis-cli config contexts']);
    if (command === 'config use-context') config.current_context = name;
    else {
      const context = config.contexts[name];
      store.remove(accountKey(directory, name, context), context.credential_backend);
      delete config.contexts[name];
      if (config.current_context === name) config.current_context = Object.keys(config.contexts)[0] || null;
    }
    saveConfig(directory, config);
    return { context: name, action: command.split(' ')[1], current_context: config.current_context };
  }
  // Validate and gate writes before touching credentials or starting a worker.
  const remote = !command.startsWith('config ') && !command.startsWith('auth ');
  const operation = remote ? planOperation(command, args, options) : { command };
  const { name, context, stored, config } = selectContext(directory, options);
  if (command === 'config show') return { directory, context: name, settings: context, read_only: options['read-only'] || ['1', 'true'].includes(process.env.REDIS_CLI_READ_ONLY) || !options['allow-writes'] };
  if (operation.write && options['dry-run']) return { dry_run: true, context: name, database: context.database, operation };
  if (command === 'auth logout') {
    store.remove(accountKey(directory, name, stored), stored.credential_backend);
    // Retain the backend marker: logout must never silently downgrade to anonymous access.
    return { context: name, logged_out: true };
  }
  const timeout = integer(options.timeout ?? 30000, '--timeout (milliseconds)', 100, 600000);
  const run = credential => runRedis({ context, credential, operation, timeout });
  if (command === 'auth login') {
    const credential = await credentialsFromUser(options);
    if (options.verify) await run(credential);
    stored.credential_backend = store.save(accountKey(directory, name, stored), credential, options['credential-store'] || 'auto');
    config.contexts[name] = stored;
    saveConfig(directory, config);
    return { context: name, stored: true, verified: !!options.verify, credential_backend: stored.credential_backend };
  }
  const credential = resolveCredential(store, directory, name, stored);
  if (command === 'auth status' && !options.verify) return { context: name, available: !!credential, source: process.env.REDIS_CLI_PASSWORD !== undefined ? 'environment' : stored.credential_backend || 'none', verified: false };
  if (command === 'doctor') {
    await run(credential);
    return { ok: true, context: name, database: context.database, driver_version: driverVersion, credentials: credential ? 'available' : 'not_configured', checks: { configuration: 'ok', driver: 'ok', connectivity: 'ok' } };
  }
  const result = await run(credential);
  return command === 'auth status' ? { context: name, available: !!credential, verified: true } : result;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const parsed = parse(argv);
    if (parsed.help) { process.stdout.write(parsed.help); return 0; }
    const value = await execute(parsed.command, parsed.args, parsed.options);
    if (parsed.command === 'skill show') process.stdout.write(value);
    else emit(value, parsed.options);
    return 0;
  } catch (error) {
    const safe = error instanceof CLIError ? error : new CLIError('internal', 'LOCAL_OPERATION_FAILED', 'A local operation failed.', 'Check filesystem permissions, credential store access and the installed runtime.');
    process.stderr.write(`${JSON.stringify(safe.payload())}\n`);
    return exits[safe.category] || 10;
  }
}
