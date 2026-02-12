// src/index.ts

export interface Env {
  SUBGRAPH_URL: string;
}

const DEFAULT_TTL_SECONDS = 5;

// Small in-flight dedupe map (per isolate) to reduce burst fan-out
const inflight = new Map<string, Promise<Response>>();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");

    try {
      // CORS preflight
      if (req.method === "OPTIONS") return handleOptions(req);

      const url = new URL(req.url);

      // ✅ Simple health check (no upstream)
      if (url.pathname === "/health") {
        return withCors(new Response("ok", { status: 200 }), origin);
      }

      // ✅ Dedicated meta endpoint (no cache hashing, very reliable)
      if (url.pathname === "/meta") {
        try {
          if (!env.SUBGRAPH_URL) {
            return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }), origin);
          }

          const upstream = await fetch(env.SUBGRAPH_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query: "query __Meta { _meta { block { number } } }",
              variables: {},
              operationName: "__Meta",
            }),
          });

          const text = await upstream.text();
          return withCors(
            new Response(text, {
              status: upstream.status,
              headers: {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
                "Cache-Control": "public, max-age=3",
                "X-Cache": "BYPASS",
              },
            }),
            origin
          );
        } catch (e) {
          return withCors(
            new Response(JSON.stringify({ error: "UPSTREAM_FETCH_FAILED", message: String(e) }), {
              status: 502,
              headers: { "content-type": "application/json" },
            }),
            origin
          );
        }
      }

      // Only proxy GraphQL here
      if (url.pathname !== "/graphql") {
        return withCors(new Response("Not found", { status: 404 }), origin);
      }

      if (req.method !== "POST") {
        return withCors(new Response("Method not allowed", { status: 405 }), origin);
      }

      if (!env.SUBGRAPH_URL) {
        return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }), origin);
      }

      // Read body once
      const raw = await req.text();
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return withCors(new Response("Bad JSON", { status: 400 }), origin);
      }

      const query = typeof body?.query === "string" ? body.query : "";
      const variables =
        body?.variables && typeof body.variables === "object" ? body.variables : {};

      if (!query) return withCors(new Response("Missing query", { status: 400 }), origin);
      if (query.length > 60_000)
        return withCors(new Response("Query too large", { status: 413 }), origin);

      // Clamp pagination and ids to protect the subgraph
      clampPagination(variables);

      // TTL policy: tweak based on query content
      const ttl = pickTtlSeconds(query);

      // Stable cache key: sha256(canonical({query, variables}))
      const cacheKey = await sha256Hex(
        canonicalStringify({
          v: 2, // bump to avoid collisions with older logic
          query,
          variables,
        })
      );

      // Synthetic GET for Cache API
      const cacheUrl = new URL(req.url);
      cacheUrl.pathname = `/__cache/${cacheKey}`;
      cacheUrl.search = "";
      const cacheReq = new Request(cacheUrl.toString(), { method: "GET" });

      const cache = caches.default;

      // Serve from cache (guarded)
      let cached: Response | undefined;
      try {
        cached = await cache.match(cacheReq);
      } catch (e) {
        console.error("cache.match failed", e);
      }

      if (cached) {
        const out = withCacheHeaders(cached, ttl, true);
        return withCors(out, origin);
      }

      // In-flight dedupe
      const existing = inflight.get(cacheKey);
      if (existing) {
        const res = await existing;
        return withCors(res.clone(), origin);
      }

      const p = (async () => {
        try {
          const upstream = await fetch(env.SUBGRAPH_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query, variables }),
          });

          const text = await upstream.text();

          // Build response (pass through status)
          let res = new Response(text, {
            status: upstream.status,
            headers: {
              "content-type": upstream.headers.get("content-type") ?? "application/json",
            },
          });

          // Cache only successful responses (guarded)
          if (upstream.ok) {
            const toCache = withCacheHeaders(res.clone(), ttl, false);
            ctx.waitUntil(
              cache.put(cacheReq, toCache).catch((e) => {
                console.error("cache.put failed", e);
              })
            );
          }

          res = withCacheHeaders(res, ttl, false);
          return res;
        } catch (err) {
          const payload = JSON.stringify({
            error: "UPSTREAM_FETCH_FAILED",
            message: err instanceof Error ? err.message : String(err),
          });
          return withCacheHeaders(
            new Response(payload, {
              status: 502,
              headers: { "content-type": "application/json" },
            }),
            0,
            false
          );
        }
      })().finally(() => {
        inflight.delete(cacheKey);
      });

      inflight.set(cacheKey, p);

      const res = await p;
      return withCors(res, origin);
    } catch (err) {
      const payload = JSON.stringify({
        error: "WORKER_INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
      return withCors(
        new Response(payload, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
        origin
      );
    }
  },
};

// -------------------- CORS --------------------

function withCors(res: Response, origin?: string | null) {
  const headers = new Headers(res.headers);

  // Dev: allow localhost. Prod: restrict later if you want.
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Vary", "Origin");

  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type");

  return new Response(res.body, { status: res.status, headers });
}

function handleOptions(req: Request) {
  const origin = req.headers.get("Origin");
  const reqHeaders = req.headers.get("Access-Control-Request-Headers") || "Content-Type";

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", reqHeaders);
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(null, { status: 204, headers });
}

// -------------------- Cache headers --------------------

function withCacheHeaders(res: Response, ttlSeconds: number, hit: boolean) {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  headers.set("X-Cache", hit ? "HIT" : "MISS");
  return new Response(res.body, { status: res.status, headers });
}

// -------------------- Limits / TTL logic --------------------

function clampPagination(variables: any) {
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;

    for (const k of Object.keys(obj)) {
      const v = obj[k];

      if (k === "first" && typeof v === "number") obj[k] = clampInt(v, 1, 50);
      if (k === "skip" && typeof v === "number") obj[k] = clampInt(v, 0, 100_000);

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

function pickTtlSeconds(query: string): number {
  const q = query.toLowerCase();
  // Make GlobalFeed / raffleEvents more reactive
  if (q.includes("globalfeed") || q.includes("raffleevents")) return 3;
  return DEFAULT_TTL_SECONDS;
}

// -------------------- Stable hashing --------------------

function canonicalStringify(value: any): string {
  const seen = new WeakSet();

  const helper = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return null;
    seen.add(v);

    if (Array.isArray(v)) return v.map(helper);

    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = helper(v[k]);
    return out;
  };

  return JSON.stringify(helper(value));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}