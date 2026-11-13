const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

async function signingKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("ADMIN_TOKEN_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("ADMIN_TOKEN_SECRET 未配置");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createAdminToken(adminId: string, ttlSeconds = 7200): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify({ sub: adminId, iat: now, exp: now + ttlSeconds, v: 1 })));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload)));
  return `v1.${payload}.${bytesToBase64Url(signature)}`;
}

export async function verifyAdminToken(token: unknown): Promise<string | null> {
  try {
    const [version, payload, signature] = String(token || "").split(".");
    if (version !== "v1" || !payload || !signature) return null;
    const valid = await crypto.subtle.verify("HMAC", await signingKey(), base64UrlToBytes(signature), encoder.encode(payload));
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    const now = Math.floor(Date.now() / 1000);
    if (claims?.v !== 1 || typeof claims?.sub !== "string" || !claims.sub || typeof claims?.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims?.iat !== "number" || claims.iat > now + 60 || claims.exp - claims.iat > 86400) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export async function hashAdminPassword(password: string): Promise<string> {
  const iterations = 210000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
  return `pbkdf2$${iterations}$${bytesToBase64Url(salt)}$${bytesToBase64Url(derived)}`;
}

export async function verifyAdminPassword(password: string, stored: string): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (!stored.startsWith("pbkdf2$")) {
    return { valid: constantTimeEqual(encoder.encode(password), encoder.encode(stored)), needsUpgrade: true };
  }
  try {
    const [, iterationText, saltText, expectedText] = stored.split("$");
    const iterations = Number(iterationText);
    if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return { valid: false, needsUpgrade: false };
    const salt = base64UrlToBytes(saltText);
    const expected = base64UrlToBytes(expectedText);
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, expected.length * 8));
    return { valid: constantTimeEqual(actual, expected), needsUpgrade: iterations < 210000 };
  } catch {
    return { valid: false, needsUpgrade: false };
  }
}

export function requestIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown").trim().slice(0, 100);
}

export function adminCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = new Set(["https://www.ip520.top", "https://ip520.top", "http://localhost:8080", "http://localhost:5173"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : "https://www.ip520.top",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  };
}
