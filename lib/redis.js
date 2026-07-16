// lib/redis.js
// Shared ioredis singleton. Reused across all API routes.

import Redis from 'ioredis';

let client = null;

export function getRedis() {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL not configured');
  }

  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // lazyConnect: don't open the TCP connection at module load — requests
    // that fail auth/validation never touch Redis, and serverless cold
    // starts don't burn Upstash connection slots unnecessarily.
    lazyConnect: true,
    connectTimeout: 10000,
  });

  client.on('error', (err) => {
    console.error('Redis error:', err.message);
  });

  return client;
}

export default getRedis;
