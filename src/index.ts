// src/index.ts
export interface Env {
  SUBGRAPH_URL: string;
}

const DEFAULT_TTL_SECONDS = 5;

/**
 * Store in-flight results as plain data (NOT Response),
 * so we never reuse a locked ReadableStream.
 */
type InflightValue = {
  status: number;
  contentType: string;
  text: string;
  ok: boolean;
};

const inflight = new Map<string, Promise<InflightValue>>();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get("Origin");

    try {
      if (req.method === "OPTIONS") return handleOptions(req);

      const url = new URL(req.url);

      // Health check
      if (url.pathname === "/health") {
        return withCors(new Response("ok", { status: 200 }), origin);
      }

      // Dedicated meta endpoint (simple + reliable)
      if (url.pathname === "/meta") {
        if (!env.SUBGRAPH_URL) {
          return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }), origin);
        }

        // IMPORTANT: edge-cache only, never browser-cache
        const ttl = 3;
        const cc = cacheControlEdgeOnly(ttl);

        try {
          const upstream = await fetchWithTimeout(
            env.SUBGRAPH_URL,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                query: "query __Meta { _meta { block { number } } }",
                variables: {},
                operationName: "__Meta",
              }),
            },
            8000
          );

          const text = await upstream.text();
          const ct = upstream.headers.get("content-type") ?? "application/json";

          const res = new Response(text, {
            status: upstream.status,
            headers: {
              "content-type": ct,
              "Cache-Control": cc,
              "CDN-Cache-Control": cc,
              // More truthful than "BYPASS": this endpoint is edge-cacheable
              "X-Cache": "MISS",
            },
          });

          return withCors(res, origin);
        } catch (e) {
          return withCors(
            new Response(JSON.stringify({ error: "UPSTREAM_FETCH_FAILED", message: String(e) }), {
              status: isAbortTimeout(e) ? 504 : 502,
              headers: { "content-type": "application/json" },
            }),
            origin
          );
        }
      }

      // GraphQL proxy
      if (url.pathname !== "/graphql") {
        return withCors(new Response("Not found", { status: 404 }), origin);
      }
      if (req.method !== "POST") {
        return withCors(new Response("Method not allowed", { status: 405 }), origin);
      }
      if (!env.SUBGRAPH_URL) {
        return withCors(new Response("Missing SUBGRAPH_URL", { status: 500 }), origin);
      }

      // Parse request body
      const raw = await req.text();
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return withCors(new Response("Bad JSON", { status: 400 }), origin);
      }

      const query = typeof body?.query === "string" ? body.query : "";
      const variables = body?.variables && typeof body.variables === "object" ? body.variables : {};

      if (!query) return withCors(new Response("Missing query", { status: 400 }), origin);
      if (query.length > 60_000) return withCors(new Response("Query too large", { status: 413 }), origin);

      // Clamp to protect indexer
      clampPagination(variables);

      const ttl = pickTtlSeconds(query);
      const cc = cacheControlEdgeOnly(ttl);

      // Cache key from query+variables (canonical)
      const hashKey = await sha256Hex(
        canonicalStringify({
          v: 5, // bump version to avoid collisions with old cache keys
          query,
          variables,
        })
      );

      // Cache API uses Request as key; we make a synthetic GET
      // IMPORTANT: ignore incoming querystring entirely to allow frontend ?cb=... without busting edge cache
      const cacheUrl = new URL(req.url);
      cacheUrl.pathname = `/__cache/${hashKey}`;
      cacheUrl.search = "";
      const cacheReq = new Request(cacheUrl.toString(), { method: "GET" });

      const cache = caches.default;

      // Cache match (guarded)
      try {
        const cached = await cache.match(cacheReq);
        if (cached) {
          // Return cached.clone() so body can be read downstream if needed
          const hit = addHeaders(cached, {
            "Cache-Control": cc,
            "CDN-Cache-Control": cc,
            "X-Cache": "HIT",
          });
          return withCors(hit, origin);
        }
      } catch (e) {
        console.error("cache.match failed", e);
      }

      // ✅ In-flight dedupe (fixed: use the SAME key for get/set/delete)
      const existing = inflight.get(hashKey);
      if (existing) {
        const v = await existing;
        const res = makeTextResponse(v, ttl, "COALESCED");
        return withCors(res, origin);
      }

      const p = (async (): Promise<InflightValue> => {
        try {
          const upstream = await fetchWithTimeout(
            env.SUBGRAPH_URL,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query, variables }),
            },
            10_000
          );

          const text = await upstream.text();
          const ct = upstream.headers.get("content-type") ?? "application/json";

          const v: InflightValue = {
            status: upstream.status,
            contentType: ct,
            text,
            ok: upstream.ok,
          };

          // Cache only ok responses
          if (v.ok) {
            const toCache = makeTextResponse(v, ttl, "MISS");
            ctx.waitUntil(cache.put(cacheReq, toCache.clone()).catch((e) => console.error("cache.put failed", e)));
          }

          return v;
        } catch (e) {
          return {
            status: isAbortTimeout(e) ? 504 : 502,
            contentType: "application/json",
            text: JSON.stringify({
              error: isAbortTimeout(e) ? "UPSTREAM_TIMEOUT" : "UPSTREAM_FETCH_FAILED",
              message: e instanceof Error ? e.message : String(e),
            }),
            ok: false,
          };
        }
      })().finally(() => {
        inflight.delete(hashKey);
      });

      inflight.set(hashKey, p);

      const v = await p;
      const res = makeTextResponse(v, ttl, "MISS");
      return withCors(res, origin);
    } catch (e) {
      return withCors(
        new Response(
          JSON.stringify({
            error: "WORKER_INTERNAL_ERROR",
            message: e instanceof Error ? e.message : String(e),
          }),
          { status: 500, headers: { "content-type": "application/json" } }
        ),
        origin
      );
    }
  },
};

// -------------------- Cache-Control helpers --------------------

/**
 * Edge-cache only:
 * - Browser: max-age=0 (always revalidate; avoids device "stickiness")
 * - Edge/shared: s-maxage=ttl (Cloudflare cache stays hot)
 * - SWR: allow instant responses while edge refreshes
 */
function cacheControlEdgeOnly(ttl: number) {
  return `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl}`;
}

// -------------------- Response builders (NO stream reuse) --------------------

function makeTextResponse(v: InflightValue, ttl: number, xCache: "HIT" | "MISS" | "COALESCED"): Response {
  const cc = cacheControlEdgeOnly(ttl);

  return new Response(v.text, {
    status: v.status,
    headers: {
      "content-type": v.contentType,
      "Cache-Control": cc,
      "CDN-Cache-Control": cc,
      "X-Cache": xCache,
    },
  });
}

/**
 * Clone response & add headers (safe even if body was consumed elsewhere).
 */
function addHeaders(res: Response, extra: Record<string, string>): Response {
  const r = res.clone();
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

// -------------------- CORS --------------------

function withCors(res: Response, origin?: string | null) {
  const r = res.clone();
  const headers = new Headers(r.headers);

  headers.set("Access-Control-Allow-Origin", origin || "*");

  // ✅ preserve any existing Vary and append Origin
  const vary = headers.get("Vary");
  if (!vary) headers.set("Vary", "Origin");
  else if (!vary.toLowerCase().includes("origin")) headers.set("Vary", `${vary}, Origin`);

  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", "Content-Type");

  return new Response(r.body, { status: r.status, headers });
}

function handleOptions(req: Request) {
  const origin = req.headers.get("Origin");
  const reqHeaders = req.headers.get("Access-Control-Request-Headers") || "Content-Type";

  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin || "*");

  // ✅ preserve + append
  headers.set("Vary", "Origin");

  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  headers.set("Access-Control-Allow-Headers", reqHeaders);
  headers.set("Access-Control-Max-Age", "86400");

  return new Response(null, { status: 204, headers });
}

// -------------------- Limits / TTL logic --------------------

function clampPagination(variables: any) {
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;

    for (const k of Object.keys(obj)) {
      const v = obj[k];

      // Conservative defaults
      if (k === "first" && typeof v === "number") obj[k] = clampInt(v, 1, 200);
      if (k === "skip" && typeof v === "number") obj[k] = clampInt(v, 0, 100_000);

      // Clamp common array vars (ids)
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

  // "hot" / fast-moving queries
  if (q.includes("globalfeed") || q.includes("raffleevents")) return 3;
  if (q.includes("_meta") || q.includes("__meta")) return 3;

  // Slightly longer for "stable" reads (details by id, participants, etc.)
  // (Tune to taste; this reduces indexer load a lot.)
  if (q.includes("rafflebyid") || q.includes("raffle(") || q.includes("raffleparticipants")) return 10;

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
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -------------------- Upstream timeout --------------------

function isAbortTimeout(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "").toLowerCase();
  return msg.includes("timeout");
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => {
    try {
      ac.abort(new Error("timeout"));
    } catch {
      // ignore
    }
  }, ms);

  try {
    return await fetch(input, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}