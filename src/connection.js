import fs from 'node:fs';
import { createRequire } from 'node:module';

export const driverVersion = createRequire(import.meta.url)('@redis/client/package.json').version;
export function connectionOptions(context, credential, timeout) {
  const socket = { host: context.host, port: context.port, connectTimeout: Math.min(timeout, 15000), reconnectStrategy: false };
  if (context.tls) {
    socket.tls = true;
    socket.rejectUnauthorized = true;
    if (context.tls_ca_file) socket.ca = fs.readFileSync(context.tls_ca_file);
    if (context.tls_certificate_file) socket.cert = fs.readFileSync(context.tls_certificate_file);
    if (context.tls_key_file) socket.key = fs.readFileSync(context.tls_key_file);
  }
  return { RESP: 2, socket, database: context.database, disableOfflineQueue: true, disableClientInfo: true, maintNotifications: 'disabled',
    ...(credential ? { password: credential.password, ...(credential.username ? { username: credential.username } : {}) } : {}) };
}
