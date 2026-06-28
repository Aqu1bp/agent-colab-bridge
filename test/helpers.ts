import { type AuthAttempt } from "../src/auth.js";

export function authFactory(token: string, prefix: string): () => AuthAttempt {
  let counter = 0;
  return () => ({
    token,
    timestamp: new Date().toISOString(),
    nonce: `${prefix}_${++counter}`,
  });
}

export function fixedAuth(token: string, nonce: string): AuthAttempt {
  return {
    token,
    timestamp: new Date().toISOString(),
    nonce,
  };
}

export function authAt(token: string, nonce: string, at: Date): AuthAttempt {
  return {
    token,
    timestamp: at.toISOString(),
    nonce,
  };
}
