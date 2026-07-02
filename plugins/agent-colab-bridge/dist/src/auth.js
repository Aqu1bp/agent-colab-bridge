import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bridgeError } from "./protocol.js";
const TOKEN_HASH_NAMESPACE = "agent-colab-bridge";
const LEGACY_TOKEN_HASH_NAMESPACES = ["codex-colab-bridge", "colab-mcp-bridge"];
export class AuthFailure extends Error {
    bridgeError;
    constructor(error) {
        super(error.message);
        this.bridgeError = error;
    }
}
export class InMemoryNonceRepository {
    nonces = new Map();
    hasNonce(sessionId, side, nonce) {
        return this.nonces.has(this.key(sessionId, side, nonce));
    }
    storeNonce(sessionId, side, nonce, seenAt) {
        this.nonces.set(this.key(sessionId, side, nonce), seenAt);
    }
    key(sessionId, side, nonce) {
        return `${sessionId}:${side}:${nonce}`;
    }
}
export function generateToken(bytes = 32) {
    return `br_${randomBytes(bytes).toString("base64url")}`;
}
export function hashToken(token) {
    return hashTokenWithNamespace(TOKEN_HASH_NAMESPACE, token);
}
export function verifyToken(token, expectedHash) {
    return (verifyTokenHash(hashToken(token), expectedHash) ||
        LEGACY_TOKEN_HASH_NAMESPACES.some((namespace) => verifyTokenHash(hashTokenWithNamespace(namespace, token), expectedHash)));
}
function hashTokenWithNamespace(namespace, token) {
    return createHash("sha256").update(`${namespace}:${token}`).digest("hex");
}
function verifyTokenHash(actualHash, expectedHash) {
    const actual = Buffer.from(actualHash, "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function validateTimestamp(timestamp, options = {}) {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) {
        throw new AuthFailure(bridgeError("UNAUTHORIZED", "Invalid auth timestamp."));
    }
    const now = options.now?.getTime() ?? Date.now();
    const skewMs = options.skewMs ?? 5 * 60 * 1000;
    if (Math.abs(now - parsed) > skewMs) {
        throw new AuthFailure(bridgeError("UNAUTHORIZED", "Auth timestamp is outside the allowed skew."));
    }
}
export function validateAuthenticatedRequest(input) {
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
    input.nonceRepository.storeNonce(input.sessionId, input.side, input.attempt.nonce, input.now?.toISOString() ?? new Date().toISOString());
}
