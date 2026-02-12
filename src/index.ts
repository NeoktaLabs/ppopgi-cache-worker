export interface Env {
  SUBGRAPH_URL: string;
}

const DEFAULT_TTL_SECONDS = 5;

// Very small in-flight dedupe map (per isolate). Helps during bursts.
const inflight = new Map<string, Promise<Response>>();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") return corsPreflight(req);

    const url = new URL(req.url);
    if (url.pathname !== "/graphql") {
      return withCors(new Response("Not found", { status: 404 }));
    }
    if (req.method !== "POST") {
      return withCors(new Response("Method not allowed", { status: 405 }));
    }

    // Read body once
    const raw = await req.text();
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return withCors(new Response("Bad JSON", { status: 400 }));
    }

    const query = typeof body?.query === "string" ? body.query : "";
    const variables = body?.variables && typeof body.variables === "object" ? body.variables : {};

    if (!query) return withCors(new Response("Missing query", { status: 400 }));
    if (query.length > 60_000) return withCors(new Response("Query too large", { status: 413 }));

    // Clamp pagination to protect The Graph + your wallet
    clampPagination(variables);

    // TTL policy: you can tune based on query content
    const ttl = pickTtlSeconds(query, variables);

    // Build stable cache key hash
    const cacheKey = await sha256Hex(
      canonicalStringify({
        v: 1, // bump if you change logic and want to bust cache keys
        query,
        variables,
      })
    );

    // Use a synthetic GET request to store in Cloudflare cache
    const cacheUrl = new URL(req.url);
    cacheUrl.pathname = `/__cache/${cacheKey}`;
    cacheUrl.search = "";
    const cacheReq = new Request(cacheUrl.toString(), { method: "GET" });

    const cache = caches.default;

    // Serve cache
    const cached = await cache.match(cacheReq);
    if (cached) {
      return withCors(withCacheHeaders(cached, ttl, true));
    }

    // In-flight dedupe
    const existing = inflight.get(cacheKey);
    if (existing) {
      const res = await existing;
      return withCors(res.clone());
    }

    const p = (async () => {
      const upstream = await fetch(env.SUBGRAPH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Optional: forward some tracing headers
          ...(req.headers.get("cf-connecting-ip")
            ? { "x-forwarded-for": req.headers.get("cf-connecting-ip")! }
            : {}),
        },
        body: JSON.stringify({ query, variables }),
      });

      const text = await upstream.text();

      // Build response
      const res = new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        },
      });

      // Cache only successful responses
      if (upstream.ok) {
        const toCache = withCacheHeaders(res.clone(), ttl, false);
        ctx.waitUntil(cache.put(cacheReq, toCache));
      }

      // Always return CORS-enabled response
      return withCors(withCacheHeaders(res, ttl, false));
    })()
      .finally(() => {
        inflight.delete(cacheKey);
      });

    inflight.set(cacheKey, p);
    return await p;
  },
};

function corsPreflight(req: Request) {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST,OPTIONS");
  headers.set("access-control-allow-headers", req.headers.get("access-control-request-headers") || "content-type");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
}

function withCors(res: Response) {
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("vary", "origin");
  return new Response(res.body, { status: res.status, headers });
}

function withCacheHeaders(res: Response, ttlSeconds: number, hit: boolean) {
  const headers = new Headers(res.headers);
  headers.set("cache-control", `public, max-age=${ttlSeconds}`);
  headers.set("x-cache", hit ? "HIT" : "MISS");
  return new Response(res.body, { status: res.status, headers });
}

function clampPagination(variables: any) {
  // Recursively clamp any "first" and "skip"
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === "first" && typeof v === "number") obj[k] = clampInt(v, 1, 50); // <-- important
      if (k === "skip" && typeof v === "number") obj[k] = clampInt(v, 0, 100_000);
      // If you have id arrays, clamp their size
      if ((k === "ids" || k.endsWith("Ids")) && Array.isArray(v)) obj[k] = v.slice(0, 200);
      walk(v);
    }
  };
  walk(variables);
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function pickTtlSeconds(query: string, variables: any): number {
  // Default 5s everywhere. Optionally tighten activity to 3s.
  const q = query.toLowerCase();

  // Your GlobalFeed query includes "raffleEvents" and "recentWinners/recentCancels"
  if (q.includes("globalfeed") || q.includes("raffleevents")) return 3;

  // Participants leaderboard can be a bit heavier; 5s is fine, or bump to 8s.
  if (q.includes("raffleparticipants")) return 5;

  return DEFAULT_TTL_SECONDS;
}

// Canonical stringify: stable ordering so cache key doesn’t fragment
function canonicalStringify(value: any): string {
  const seen = new WeakSet();

  const helper = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);

    if (Array.isArray(v)) return v.map(helper);

    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = helper(v[k]);
    }
    return out;
  };

  return JSON.stringify(helper(value));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}