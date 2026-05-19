// Shared auth helper for serverless endpoints.
// Accepts either:
//  1. x-google-token header (JWT ID token from Google Identity Services)
//  2. x-app-password header (legacy backup auth)
//
// Returns { userKey, kind, email? } when authorized, or sends a response and returns null.
//
// userKey is used to derive Redis storage keys; differs by auth method:
//  - Google login → keyed by email hash (each user isolated)
//  - Password fallback → keyed by password hash (single legacy bucket)

import crypto from "node:crypto";

function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

// Verify a Google ID token against Google's public keys.
// Caches the public keys for ~1h.
let cachedKeys = null;
let cachedKeysAt = 0;
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;

async function getGoogleKeys() {
  if (cachedKeys && Date.now() - cachedKeysAt < KEY_CACHE_TTL_MS) {
    return cachedKeys;
  }
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("Failed to fetch Google keys");
  const data = await res.json();
  cachedKeys = data.keys;
  cachedKeysAt = Date.now();
  return cachedKeys;
}

function base64urlToBuffer(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function base64urlDecode(str) {
  return base64urlToBuffer(str).toString("utf8");
}

// Verify Google JWT. Returns { email, name, picture, sub } or throws.
async function verifyGoogleToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");

  const header = JSON.parse(base64urlDecode(parts[0]));
  const payload = JSON.parse(base64urlDecode(parts[1]));
  const signatureBuf = base64urlToBuffer(parts[2]);
  const signedData = `${parts[0]}.${parts[1]}`;

  // Validate basic payload claims
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("Token expired");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") {
    throw new Error("Invalid issuer");
  }
  const expectedAud = process.env.GOOGLE_CLIENT_ID;
  if (!expectedAud) throw new Error("GOOGLE_CLIENT_ID not configured");
  if (payload.aud !== expectedAud) throw new Error("Invalid audience");
  if (!payload.email_verified) throw new Error("Email not verified");

  // Find the right public key
  const keys = await getGoogleKeys();
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error("Signing key not found");

  // Build a public key in PEM-ish form for Node's crypto.verify
  // Google JWKS uses RSA keys with n + e. We can construct a JWK and import directly.
  const publicKey = crypto.createPublicKey({
    key: { kty: key.kty, n: key.n, e: key.e },
    format: "jwk",
  });

  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signedData),
    publicKey,
    signatureBuf
  );
  if (!verified) throw new Error("Invalid signature");

  return {
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    sub: payload.sub,
  };
}

function parseAllowlist() {
  const raw = process.env.ALLOWED_EMAILS || "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Main entry: try Google token, fall back to password.
// On success: returns { userKey, kind, email? }
// On failure: sends response with res.status(...).json(...) and returns null.
export async function authenticate(req, res) {
  const googleToken = req.headers["x-google-token"];
  const password = req.headers["x-app-password"];

  // 1. Try Google token
  if (googleToken) {
    try {
      const claims = await verifyGoogleToken(googleToken);
      const email = (claims.email || "").toLowerCase();
      const allowlist = parseAllowlist();
      if (allowlist.length > 0 && !allowlist.includes(email)) {
        res.status(403).json({ error: "Email not allowed", email });
        return null;
      }
      return {
        kind: "google",
        userKey: `email:${hash(email)}`,
        email,
        name: claims.name,
        picture: claims.picture,
      };
    } catch (e) {
      res.status(401).json({ error: `Invalid Google token: ${e.message}` });
      return null;
    }
  }

  // 2. Fall back to password
  const expectedPassword = process.env.APP_PASSWORD;
  if (!expectedPassword) {
    res.status(500).json({ error: "APP_PASSWORD not configured" });
    return null;
  }
  if (password === expectedPassword) {
    return {
      kind: "password",
      userKey: `pwd:${hash(expectedPassword)}`,
    };
  }

  res.status(401).json({ error: "Unauthorized" });
  return null;
}
