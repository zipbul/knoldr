// Network bind defaults for the MCP server.

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5100;

export function resolveHost(): string {
  return process.env.KNOLDR_HOST ?? DEFAULT_HOST;
}

export function resolvePort(): number {
  return Number(process.env.KNOLDR_PORT ?? DEFAULT_PORT);
}
