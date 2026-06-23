import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";
import os from "os";

const CACHE_FILE = path.join(os.tmpdir(), "medipulse_local_cache.json");

// Disk-based fallback cache for local development to share data across Next.js worker threads.
class LocalCache {
  private readCache(): {
    cache: Record<string, { payload: string; expiresAt: number }>;
    ipFailures: Record<string, { count: number; blockedUntil: number }>;
  } {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const data = fs.readFileSync(CACHE_FILE, "utf-8");
        return JSON.parse(data);
      }
    } catch (e) {
      // Ignore read errors
    }
    return { cache: {}, ipFailures: {} };
  }

  private writeCache(data: {
    cache: Record<string, { payload: string; expiresAt: number }>;
    ipFailures: Record<string, { count: number; blockedUntil: number }>;
  }) {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      // Ignore write errors
    }
  }

  get(key: string): string | null {
    const data = this.readCache();
    const record = data.cache[key];
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      delete data.cache[key];
      this.writeCache(data);
      return null;
    }
    return record.payload;
  }

  set(key: string, val: string, ttlSec: number) {
    const data = this.readCache();
    data.cache[key] = {
      payload: val,
      expiresAt: Date.now() + ttlSec * 1000,
    };
    this.writeCache(data);
  }

  delete(key: string) {
    const data = this.readCache();
    delete data.cache[key];
    this.writeCache(data);
  }

  isBlocked(ip: string): boolean {
    const data = this.readCache();
    const record = data.ipFailures[ip];
    if (!record) return false;
    if (Date.now() > record.blockedUntil) {
      delete data.ipFailures[ip];
      this.writeCache(data);
      return false;
    }
    return record.count >= 3;
  }

  incrementFailure(ip: string) {
    const data = this.readCache();
    const record = data.ipFailures[ip] || { count: 0, blockedUntil: 0 };
    record.count += 1;
    if (record.count >= 3) {
      record.blockedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24-hour lockout
    }
    data.ipFailures[ip] = record;
    this.writeCache(data);
    return record.count;
  }

  resetFailure(ip: string) {
    const data = this.readCache();
    delete data.ipFailures[ip];
    this.writeCache(data);
  }
}

const localCache = new LocalCache();

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = !!(redisUrl && redisToken);

const redis = useRedis ? new Redis({ url: redisUrl!, token: redisToken! }) : null;

const TTL_ONE_HOUR = 3600;

export async function POST(req: NextRequest) {
  try {
    const { lookup_hash, encrypted_payload } = await req.json();
    if (!lookup_hash || !encrypted_payload) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    console.log("MediPulse API POST: Uploading report. Hash =", lookup_hash);

    if (useRedis && redis) {
      await redis.set(`report:${lookup_hash}`, encrypted_payload, { ex: TTL_ONE_HOUR });
    } else {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json({ error: "Database configuration error: Redis is missing." }, { status: 500 });
      }
      localCache.set(`report:${lookup_hash}`, encrypted_payload, TTL_ONE_HOUR);
      console.warn("MediPulse: Using in-memory fallback cache. Configure UPSTASH_REDIS envs for production.");
    }

    return NextResponse.json({ status: "success" }, { status: 201 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json({ error: "Failed to persist payload" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const ip = req.ip || req.headers.get("x-forwarded-for") || "local-dev";
    
    // 1. Enforce IP Blocklist
    if (useRedis && redis) {
      const isBlocked = await redis.get(`block:ip:${ip}`);
      if (isBlocked) {
        return NextResponse.json({ error: "Access locked due to excessive failed attempts" }, { status: 429 });
      }
    } else {
      if (localCache.isBlocked(ip)) {
        return NextResponse.json({ error: "Access locked due to excessive failed attempts" }, { status: 429 });
      }
    }

    const { searchParams } = new URL(req.url);
    const hash = searchParams.get("hash");
    if (!hash) {
      return NextResponse.json({ error: "Missing lookup hash parameter" }, { status: 400 });
    }

    console.log("MediPulse API GET: Fetching report. Hash =", hash);

    let encryptedPayload: string | null = null;

    if (useRedis && redis) {
      encryptedPayload = await redis.get(`report:${hash}`);
    } else {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json({ error: "Database configuration error: Redis is missing." }, { status: 500 });
      }
      encryptedPayload = localCache.get(`report:${hash}`);
    }

    // 2. Handle missing record & increment failure logs
    if (!encryptedPayload) {
      console.log("MediPulse API GET: Report NOT found for hash =", hash);
      let currentFailures = 0;

      if (useRedis && redis) {
        currentFailures = await redis.incr(`fail:ip:${ip}`);
        await redis.expire(`fail:ip:${ip}`, TTL_ONE_HOUR);

        if (currentFailures >= 3) {
          await redis.set(`block:ip:${ip}`, "blocked", { ex: 86400 }); // 24-hour block
        }
      } else {
        currentFailures = localCache.incrementFailure(ip);
      }

      return NextResponse.json({ 
        error: "Report not found or has expired.", 
        remainingAttempts: Math.max(0, 3 - currentFailures) 
      }, { status: 404 });
    }

    console.log("MediPulse API GET: Successfully retrieved report for hash =", hash);

    // 3. Clear failures on successful lookup
    if (useRedis && redis) {
      await redis.del(`fail:ip:${ip}`);
    } else {
      localCache.resetFailure(ip);
    }

    return NextResponse.json({ encrypted_payload: encryptedPayload });
  } catch (error) {
    console.error("Retrieval error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const hash = searchParams.get("hash");
    if (!hash) {
      return NextResponse.json({ error: "Missing lookup hash parameter" }, { status: 400 });
    }

    if (useRedis && redis) {
      await redis.del(`report:${hash}`);
    } else {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json({ error: "Database configuration error: Redis is missing." }, { status: 500 });
      }
      localCache.delete(`report:${hash}`);
    }

    console.log("MediPulse API DELETE: Revoked report for hash =", hash);
    return NextResponse.json({ status: "success" }, { status: 200 });
  } catch (error) {
    console.error("Revocation error:", error);
    return NextResponse.json({ error: "Failed to revoke payload" }, { status: 500 });
  }
}
