import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bridgeError, type BridgeError } from "./protocol.js";

const TOKEN_HASH_NAMESPACE = "agent-colab-bridge";
const LEGACY_TOKEN_HASH_NAMESPACES = ["codex-colab-bridge", "colab-mcp-bridge"];
export const DEFAULT_AUTH_SKEW_MS = 5 * 60 * 1000;

export interface AuthAttempt {
  token: string;
  timestamp: string;
  nonce: string;
}

export interface NonceRepository {
  hasNonce(sessionId: string, side: AuthSide, nonce: string): boolean;
  storeNonce(sessionId: string, side: AuthSide, nonce: string, seenAt: string): void;
}

export type AuthSide = "controller" | "runner";

export class AuthFailure extends Error {
  readonly bridgeError: BridgeError;

  constructor(error: BridgeError) {
    super(error.message);
    this.bridgeError = error;
  }
}

export class InMemoryNonceRepository implements NonceRepository {
  private readonly nonces = new Map<string, string>();

  hasNonce(sessionId: string, side: AuthSide, nonce: string): boolean {
    return this.nonces.has(this.key(sessionId, side, nonce));
  }

  storeNonce(sessionId: string, side: AuthSide, nonce: string, seenAt: string): void {
    this.nonces.set(this.key(sessionId, side, nonce), seenAt);
  }

  private key(sessionId: string, side: AuthSide, nonce: string): string {
    return `${sessionId}:${side}:${nonce}`;
  }
}

export function generateToken(bytes = 32): string {
  return `br_${randomBytes(bytes).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return hashTokenWithNamespace(TOKEN_HASH_NAMESPACE, token);
}

export function verifyToken(token: string, expectedHash: string): boolean {
  return (
    verifyTokenHash(hashToken(token), expectedHash) ||
    LEGACY_TOKEN_HASH_NAMESPACES.some((namespace) =>
      verifyTokenHash(hashTokenWithNamespace(namespace, token), expectedHash),
    )
  );
}

function hashTokenWithNamespace(namespace: string, token: string): string {
  return createHash("sha256").update(`${namespace}:${token}`).digest("hex");
}

function verifyTokenHash(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateTimestamp(
  timestamp: string,
  options: { now?: Date; skewMs?: number } = {},
): void {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new AuthFailure(bridgeError("UNAUTHORIZED", "Invalid auth timestamp."));
  }

  const now = options.now?.getTime() ?? Date.now();
  const skewMs = options.skewMs ?? DEFAULT_AUTH_SKEW_MS;
  if (Math.abs(now - parsed) > skewMs) {
    throw new AuthFailure(bridgeError("UNAUTHORIZED", "Auth timestamp is outside the allowed skew."));
  }
}

export function validateAuthenticatedRequest(input: {
  sessionId: string;
  side: AuthSide;
  attempt: AuthAttempt;
  expectedTokenHash: string;
  nonceRepository: NonceRepository;
  now?: Date;
  skewMs?: number;
}): void {
  validateTimestamp(input.attempt.timestamp, {
    now: input.now,
    skewMs: input.skewMs,
  });

  if (!verifyToken(input.attempt.token, input.expectedTokenHash)) {
    throw new AuthFailure(bridgeError("UNAUTHORIZED", "Invalid credentials."));
  }

  if (!input.attempt.nonce) {
    throw new AuthFailure(bridgeError("UNAUTHORIZED", "Missing auth nonce."));
  }

  if (input.nonceRepository.hasNonce(input.sessionId, input.side, input.attempt.nonce)) {
    throw new AuthFailure(bridgeError("REPLAY_DETECTED", "Nonce has already been used."));
  }

  input.nonceRepository.storeNonce(
    input.sessionId,
    input.side,
    input.attempt.nonce,
    input.now?.toISOString() ?? new Date().toISOString(),
  );
}
