const strings = names => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, { type: 'string' }]));
const booleans = names => Object.fromEntries(names.split(' ').filter(Boolean).map(name => [name, { type: 'boolean' }]));
const json = name => strings(`${name} ${name}-file`);
const key = booleans('key-base64');
const scan = strings('cursor count pattern');
const page = strings('skip limit');
const write = booleans('dry-run');
const value = strings('value value-file');
export const globals = { ...strings('config use-context database format fields timeout'), ...booleans('help version pretty allow-writes read-only') };
export const specs = {
  version: { args: 0, description: 'Show CLI, Node.js and bundled Redis client versions.' },
  doctor: { args: 0, description: 'Check local configuration, credentials and Redis connectivity.' },
  ping: { args: 0, description: 'Ping the selected Redis connection.' },
  'config init': { args: 0, description: 'Configure host, port and a hidden password in your own terminal. Empty password means no authentication.', options: { ...strings('name credential-store username tls-ca-file tls-certificate-file tls-key-file'), ...booleans('tls') } },
  'config show': { args: 0, description: 'Show non-secret connection settings and config directory.' },
  'config contexts': { args: 0, description: 'List configured connection aliases.' },
  'config set-context': { args: 1, operand: '<name>', description: 'Set non-secret connection options; endpoint changes require login again.', options: { ...strings('host port tls-ca-file tls-certificate-file tls-key-file'), ...booleans('tls') } },
  'config use-context': { args: 1, operand: '<name>', description: 'Choose the default connection.' },
  'config delete-context': { args: 1, operand: '<name>', description: 'Remove a local connection and its stored credentials.' },
  'auth login': { args: 0, description: 'Store a hidden password locally; optionally verify before saving.', options: { ...strings('credential-store username'), ...booleans('verify') } },
  'auth status': { args: 0, description: 'Check local credential availability without revealing identity; --verify also connects.', options: booleans('verify') },
  'auth logout': { args: 0, description: 'Remove the selected locally stored credential.' },
  'skill install': { args: 0, description: 'Install the companion Redis skill.', options: { ...strings('agent dir'), ...booleans('project force') } },
  'skill status': { args: 0, description: 'Compare bundled and installed skill versions.', options: { ...strings('agent dir'), ...booleans('project') } },
  'skill path': { args: 0, description: 'Show companion skill installation paths.', options: { ...strings('agent dir'), ...booleans('project') } },
  'skill show': { args: 0, description: 'Print the bundled skill.' },
  'server info': { args: 0, description: 'Read a supported INFO section; values remain strings.', options: strings('section') },
  'db list': { args: 0, description: 'List nonempty logical databases from INFO keyspace (not an ACL database inventory).' },
  'db size': { args: 0, description: 'Count keys in the selected database.' },
  'key scan': { args: 0, description: 'Read one SCAN page. COUNT is a hint; continue until cursor 0, including empty pages.', options: { ...scan, ...strings('type') } },
  'key inspect': { args: 1, operand: '<key>', description: 'Inspect type, PTTL and type-specific length.', options: key },
  'key exists': { args: 1, operand: '<key>', description: 'Check whether one literal key exists.', options: key },
  'key ttl': { args: 1, operand: '<key>', description: 'Read TTL in milliseconds: -1 persistent, -2 absent.', options: key },
  'key delete': { args: 1, operand: '<key>', description: 'Delete one literal key (write); no wildcard expansion.', options: { ...key, ...write } },
  'key expire': { args: 1, operand: '<key>', description: 'Set a positive expiry in seconds (write).', options: { ...key, ...write, ...strings('seconds') } },
  'key persist': { args: 1, operand: '<key>', description: 'Remove a key expiry (write).', options: { ...key, ...write } },
  'string get': { args: 1, operand: '<key>', description: 'Read a bounded byte range of a string; UTF-8 or {$base64} output.', options: { ...key, ...strings('offset bytes') } },
  'string set': { args: 1, operand: '<key>', description: 'Set a string from --value or raw --value-file (write); replaces existing value and TTL by default.', options: { ...key, ...write, ...value, ...strings('expires'), ...booleans('nx xx keep-ttl') } },
  'string increment': { args: 1, operand: '<key>', description: 'Add a signed int64 amount atomically (write); returns a decimal string.', options: { ...key, ...write, ...strings('by') } },
  'hash get': { args: 1, operand: '<key>', description: 'Read one hash field; use hash scan to discover fields.', options: { ...key, ...strings('field') } },
  'hash scan': { args: 1, operand: '<key>', description: 'Read one HSCAN page without truncating server results.', options: { ...key, ...scan } },
  'hash set': { args: 1, operand: '<key>', description: 'Set a nonempty JSON object of string field values (write).', options: { ...key, ...write, ...json('entries') } },
  'hash delete': { args: 1, operand: '<key>', description: 'Delete explicitly named fields (write).', options: { ...key, ...write, ...json('members') } },
  'list range': { args: 1, operand: '<key>', description: 'Read a bounded list page using zero-based offset.', options: { ...key, ...page } },
  'list push': { args: 1, operand: '<key>', description: 'Push a JSON array of strings to the left or right (write).', options: { ...key, ...write, ...json('values'), ...strings('side') } },
  'set scan': { args: 1, operand: '<key>', description: 'Read one SSCAN page without truncation.', options: { ...key, ...scan } },
  'set add': { args: 1, operand: '<key>', description: 'Add explicitly provided string members (write).', options: { ...key, ...write, ...json('members') } },
  'set remove': { args: 1, operand: '<key>', description: 'Remove explicitly provided string members (write).', options: { ...key, ...write, ...json('members') } },
  'zset range': { args: 1, operand: '<key>', description: 'Read a bounded rank page with scores as decimal strings.', options: { ...key, ...page, ...booleans('reverse') } },
  'zset add': { args: 1, operand: '<key>', description: 'Add JSON [{value,score}] entries (write).', options: { ...key, ...write, ...json('entries') } },
  'zset remove': { args: 1, operand: '<key>', description: 'Remove explicitly provided sorted set members (write).', options: { ...key, ...write, ...json('members') } },
  'stream range': { args: 1, operand: '<key>', description: 'Read a bounded stream page; --after resumes exclusively after an ID.', options: { ...key, ...strings('after limit') } },
  'stream add': { args: 1, operand: '<key>', description: 'Append a JSON object of string field values (write).', options: { ...key, ...write, ...json('entries') } },
  'stream delete': { args: 1, operand: '<key>', description: 'Delete explicitly named stream IDs (write).', options: { ...key, ...write, ...json('ids') } }
};

export function help(command) {
  const spec = specs[command];
  const heading = spec ? `redis-cli ${command}${spec.operand ? ` ${spec.operand}` : ''}\n\n${spec.description}` : `redis-cli — Redis for coding agents\n\nUsage: redis-cli <noun> <verb> [options]\n\n${Object.entries(specs).filter(([name]) => !command || name.startsWith(`${command} `)).map(([name, value]) => `  ${name.padEnd(24)} ${value.description}`).join('\n')}`;
  return `${heading}\n\nOptions:\n${Object.entries({ ...globals, ...spec?.options }).map(([name, value]) => `  --${name}${value.type === 'string' ? ' <value>' : ''}`).join('\n')}\n\nJSON stdout; structured JSON errors on stderr. Writes require --allow-writes.\nStart: redis-cli config init → redis-cli doctor → redis-cli key scan\n`;
}
