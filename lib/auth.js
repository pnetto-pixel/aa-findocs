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

async function getGoogleCerts() {
  const now = Date.now();
  if (cachedCerts && now < certsExpiry) return cachedCerts;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('Failed to fetch Google certs');
  cachedCerts = await res.json();
  certsExpiry = now + 60 * 60 * 1000;
  return cachedCerts;
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

  const certs = await getGoogleCerts();
  const jwk = certs.keys.find((k) => k.kid === header.kid);
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

async function getRedisAllowlist() {
  try {
    const redis = getRedis();
    const emails = await redis.smembers(ALLOWLIST_KEY);
    return emails.map((e) => e.toLowerCase());
  } catch (err) {
    console.error('Redis allowlist read failed:', err.message);
    return [];
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
    const pw = String(password).trim();
    if (pw !== expected) {
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
