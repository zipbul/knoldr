/** Validate Bearer token from Authorization header. */
export function authenticate(request: Request): boolean {
  const token = process.env.KNOLDR_API_TOKEN;
  if (!token) return true; // no token configured = open access

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const [scheme, value] = authHeader.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === token;
}
