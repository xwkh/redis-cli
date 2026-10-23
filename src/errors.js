export const exits = { usage: 2, config: 3, auth: 4, permission: 5, not_found: 6, network: 7, timeout: 8, dependency: 9, internal: 10, query: 11 };
export class CLIError extends Error {
  constructor(category, code, message, hint, nextSteps = [], retryable = false) {
    super(message);
    Object.assign(this, { category, code, hint, next_steps: nextSteps, retryable });
  }
  payload() { return { error: { category: this.category, code: this.code, message: this.message, hint: this.hint || 'Run redis-cli --help.', next_steps: this.next_steps, retryable: this.retryable } }; }
}
export const usage = (message, code = 'BAD_ARGUMENT') => new CLIError('usage', code, message, 'Check the command help and supported inputs.', ['redis-cli --help']);

// The worker forwards only recognized error labels, never server messages.
export function remoteError(error = {}) {
  switch (error.code) {
    case 'WRONGPASS': case 'NOAUTH': case 'AUTH_FAILED': return new CLIError('auth', 'AUTHENTICATION_FAILED', 'Redis authentication failed.', 'Check the password and optional ACL username locally.', ['redis-cli auth login']);
    case 'NOPERM': case 'READONLY': return new CLIError('permission', 'PERMISSION_DENIED', 'Redis denied the operation.', 'Check ACL permissions and whether this endpoint is a replica.');
    case 'WRONGTYPE': return new CLIError('query', 'WRONG_TYPE', 'The Redis key has a different data type.', 'Inspect the key type first.', ['redis-cli key inspect <key>']);
    case 'MOVED': case 'ASK': return new CLIError('config', 'CLUSTER_UNSUPPORTED', 'This endpoint requires Redis Cluster routing.', 'This release supports a standalone endpoint; cluster routing is unavailable.');
    case 'NOT_FOUND': return new CLIError('not_found', 'KEY_NOT_FOUND', 'The Redis key does not exist.', 'Discover keys first.');
    case 'INVALID_DATABASE': return new CLIError('config', 'INVALID_DATABASE', 'Redis rejected the database selection.', 'Select a database index supported by this server.');
    case 'TLS_CONFIG': return new CLIError('config', 'TLS_CONFIG_INVALID', 'The local TLS configuration could not be loaded.', 'Check the configured CA, certificate and key files.');
    case 'FIELD_TOO_LARGE': return new CLIError('query', 'OUTPUT_TOO_LARGE', 'The hash field exceeds the 1 MiB read limit.', 'Hash get reads fields up to 1 MiB.');
    case 'TOO_LARGE': return new CLIError('query', 'OUTPUT_TOO_LARGE', 'Redis response exceeded 16 MiB.', 'Use a smaller byte range, page or scan count.');
    case 'NETWORK': return new CLIError('network', 'CONNECTION_FAILED', 'Could not connect to Redis.', 'Check host, port, TLS, network and server availability.', ['redis-cli doctor'], true);
    case 'TIMEOUT': return new CLIError('timeout', 'QUERY_TIMEOUT', 'Redis operation timed out.', 'Narrow the operation or increase --timeout.', [], true);
    default: return new CLIError('query', 'REDIS_OPERATION_FAILED', 'Redis rejected the operation.', 'Check command inputs, server version, ACL permissions and key types.');
  }
}
