// Network defaults + admission predicates shared by the MCP server and
// the auth gate, so the fail-closed host check (auth.ts) and the actual
// bind (server.ts) can never silently disagree on what "the host" is.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5100;

export function resolveHost(): string {
  return process.env.KNOLDR_HOST ?? DEFAULT_HOST;
}

export function resolvePort(): number {
  return Number(process.env.KNOLDR_PORT ?? DEFAULT_PORT);
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
}
