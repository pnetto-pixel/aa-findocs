// lib/auth.js
// Auth: Google JWT verify + password fallback.
// Reads custom headers: x-google-token, x-app-password.
// Allowlist multi-source: ALLOWED_EMAILS env + Redis set + ADMIN_EMAILS env.

import crypto from 'crypto';
import { getRedis } from './redis.js';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWLIST_KEY = 'portfolio:allowlist';

let cachedCerts = null;
let certsExpiry = 0;

async function getGoogleCerts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCerts && now < certsExpiry) return cachedCerts;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('Failed to fetch Google certs');
  cachedCerts = await res.json();
  certsExpiry = now + 60 * 60 * 1000;
  return cachedCerts;
}

export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function base64UrlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

async function verifyGoogleToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const header = JSON.parse(base64UrlDecode(parts[0]).toString());
  const payload = JSON.parse(base64UrlDecode(parts[1]).toString());
  const signature = base64UrlDecode(parts[2]);
  const signedData = `${parts[0]}.${parts[1]}`;

  let certs = await getGoogleCerts();
  let jwk = certs.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Google may have rotated keys since we cached the JWKS — refetch once
    // before rejecting, so fresh tokens don't fail for up to an hour.
    certs = await getGoogleCerts(true);
    jwk = certs.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Signing key not found');

  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signedData);
  if (!verifier.verify(pubKey, signature)) {
    throw new Error('Invalid signature');
  }

  const expectedAud = process.env.GOOGLE_CLIENT_ID;
  if (expectedAud && payload.aud !== expectedAud) {
    throw new Error('Invalid audience');
  }
  if (
    payload.iss !== 'https://accounts.google.com' &&
    payload.iss !== 'accounts.google.com'
  ) {
    throw new Error('Invalid issuer');
  }
  if (payload.exp * 1000 < Date.now()) throw new Error('Token expired');

  return payload;
}

function sha256Short(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function getEnvList(name) {
  const raw = process.env[name] || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// In-memory allowlist cache: saves one Redis roundtrip per authenticated
// request on warm instances. 60s TTL keeps invite/remove near-immediate.
let cachedAllowlist = null;
let allowlistExpiry = 0;
const ALLOWLIST_TTL_MS = 60 * 1000;

async function getRedisAllowlist() {
  const now = Date.now();
  if (cachedAllowlist && now < allowlistExpiry) return cachedAllowlist;
  try {
    const redis = getRedis();
    const emails = await redis.smembers(ALLOWLIST_KEY);
    cachedAllowlist = emails.map((e) => e.toLowerCase());
    allowlistExpiry = now + ALLOWLIST_TTL_MS;
    return cachedAllowlist;
  } catch (err) {
    console.error('Redis allowlist read failed:', err.message);
    return cachedAllowlist || [];
  }
}

export async function isEmailAllowed(email) {
  if (!email) return false;
  const e = email.toLowerCase();
  const envAllowed = getEnvList('ALLOWED_EMAILS');
  const admins = getEnvList('ADMIN_EMAILS');
  if (envAllowed.includes(e) || admins.includes(e)) return true;
  const redisAllowed = await getRedisAllowlist();
  return redisAllowed.includes(e);
}

export function isAdmin(email) {
  if (!email) return false;
  const admins = getEnvList('ADMIN_EMAILS');
  return admins.includes(email.toLowerCase());
}

export function emailStorageKey(email) {
  return `portfolio:email:${sha256Short(email.toLowerCase())}:holdings`;
}

export function passwordStorageKey(password) {
  return `portfolio:pwd:${sha256Short(password)}:holdings`;
}

// --- Password brute-force protection -------------------------------------
// Failed x-app-password attempts are counted per IP in Redis. Fails open:
// if Redis is unreachable the check is skipped rather than locking out auth.
const PWD_RL_WINDOW_SEC = 15 * 60;
const PWD_RL_MAX_FAILURES = 10;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function pwdRateLimitKey(ip) {
  return `portfolio:ratelimit:pwd:${ip}`;
}

async function isPasswordRateLimited(ip) {
  try {
    const redis = getRedis();
    const count = await redis.get(pwdRateLimitKey(ip));
    return Number(count) >= PWD_RL_MAX_FAILURES;
  } catch {
    return false;
  }
}

async function registerPasswordFailure(ip) {
  try {
    const redis = getRedis();
    const key = pwdRateLimitKey(ip);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, PWD_RL_WINDOW_SEC);
  } catch {}
}

export async function authenticate(req) {
  const googleToken =
    req.headers['x-google-token'] || req.headers['X-Google-Token'];
  const password =
    req.headers['x-app-password'] || req.headers['X-App-Password'];

  if (googleToken) {
    try {
      const payload = await verifyGoogleToken(String(googleToken).trim());
      const email = (payload.email || '').toLowerCase();
      if (!email) {
        return { ok: false, status: 401, error: 'No email in token' };
      }
      const allowed = await isEmailAllowed(email);
      if (!allowed) {
        return { ok: false, status: 403, error: 'Email not allowed' };
      }
      return {
        ok: true,
        method: 'google',
        email,
        name: payload.name || null,
        picture: payload.picture || null,
        storageKey: emailStorageKey(email),
        admin: isAdmin(email),
      };
    } catch (err) {
      return {
        ok: false,
        status: 401,
        error: `Invalid Google token: ${err.message}`,
      };
    }
  }

  if (password) {
    const expected = process.env.APP_PASSWORD;
    if (!expected) {
      return { ok: false, status: 500, error: 'APP_PASSWORD not configured' };
    }
    const ip = getClientIp(req);
    if (await isPasswordRateLimited(ip)) {
      return {
        ok: false,
        status: 429,
        error: 'Too many failed attempts. Try again later.',
      };
    }
    const pw = String(password).trim();
    if (!constantTimeEqual(pw, expected)) {
      await registerPasswordFailure(ip);
      return { ok: false, status: 401, error: 'Invalid password' };
    }
    return {
      ok: true,
      method: 'password',
      email: null,
      storageKey: passwordStorageKey(pw),
      admin: false,
    };
  }

  return { ok: false, status: 401, error: 'No auth provided' };
}
