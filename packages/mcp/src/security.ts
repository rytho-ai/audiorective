import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The WebSocket subprotocol a page offers to say it speaks the bridge protocol. The server selects this one and never echoes the token
 * subprotocol back, so the token does not appear in the response.
 */
export const BRIDGE_PROTOCOL = "audiorective.v1";
/** The prefix of the subprotocol that carries the pairing token: `audiorective.token.<token>`. */
export const TOKEN_PROTOCOL_PREFIX = "audiorective.token.";

/**
 * The origins a page may connect from when `allowedOrigins` is not given: this machine's loopback names on any port, over `http`.
 * A page served from the developer's own dev server qualifies; a page from the internet never does, whatever tab it runs in.
 * `https` and other hosts are not included, because an app served over `https` or from another host must be named on purpose.
 */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"];

const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/*?#\s]+(:\*)?$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,}$/;

/** Throws when `patterns` holds an entry that is not an origin (`scheme://host`, `scheme://host:port`, `scheme://host:*`) or the opaque origin `null`. */
export function checkOriginPatterns(patterns: readonly string[]): void {
  for (const pattern of patterns) {
    if (pattern !== "null" && !ORIGIN_PATTERN.test(pattern))
      throw new Error(
        `allowedOrigins entry "${pattern}" is not an origin. Use "scheme://host", "scheme://host:port" or "scheme://host:*" (any port).`,
      );
  }
}

/**
 * True when `origin` (the `Origin` header of the handshake) equals one of `patterns` exactly, ignoring case. A pattern ending in `:*` matches
 * its host with any port and without one. Nothing else is a wildcard, so `http://localhost:*` does not match `http://localhost.evil.example`.
 */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  const candidate = origin.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (!pattern.endsWith(":*")) return candidate === pattern;
    const prefix = pattern.slice(0, -2);
    return candidate === prefix || (candidate.startsWith(`${prefix}:`) && /^\d{1,5}$/.test(candidate.slice(prefix.length + 1)));
  });
}

/** A new random pairing token: 256 bits from the system's secure random source, as 43 URL-safe characters. */
export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Throws when `token` is not at least 22 characters (about 128 bits) of `A-Z a-z 0-9 _ -`, the characters a WebSocket subprotocol can carry. */
export function checkToken(token: string): void {
  if (!TOKEN_PATTERN.test(token))
    throw new Error("The pairing token must be at least 22 characters of letters, digits, _ and - (use the one the server printed).");
}

/** The subprotocols a page offers for `token`: the bridge protocol and the token. */
export function tokenProtocols(token: string): string[] {
  checkToken(token);
  return [BRIDGE_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`];
}

/** The pairing token inside a `Sec-WebSocket-Protocol` header value, or undefined. */
export function tokenFromProtocolHeader(header: string | undefined): string | undefined {
  for (const entry of (header ?? "").split(",")) {
    const protocol = entry.trim();
    if (protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) return protocol.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return undefined;
}

/** Compares two tokens in constant time, so the check does not leak how many leading characters matched. */
export function tokensEqual(expected: string, offered: string | undefined): boolean {
  if (offered === undefined) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(offered));
}

/** The origin as one safe log token: JSON-quoted (control characters escaped) and cut to 100 characters. */
export function describeOrigin(origin: string | undefined): string {
  if (origin === undefined) return "(none)";
  return JSON.stringify(origin.length > 100 ? `${origin.slice(0, 100)}…` : origin);
}
