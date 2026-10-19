const encoder = new TextEncoder();

/** SHA-256 hex digest. API keys are 256 bits of entropy, so a fast hash is fine. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return toHex(new Uint8Array(digest));
}

/** `wdb_` + 32 random bytes as base64url. Prefix `wdb_` makes keys greppable. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `wdb_${base64url(bytes)}`;
}

export function keyPrefix(token: string): string {
  return token.slice(4, 12);
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
