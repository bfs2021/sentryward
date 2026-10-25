import { vi } from "vitest";

export interface StubRoute {
  method?: string;
  url: RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  // Answers at most this many requests, so a later route can answer the
  // next one (a refused call and its retry, say).
  times?: number;
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

// A fetch that answers from a route table and records every call. Unmatched
// requests fail loudly so a test can never reach the network by accident.
export function fetchStub(routes: StubRoute[]) {
  const calls: FetchCall[] = [];
  const used = new Map<StubRoute, number>();
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const route = routes.find(
      (r) => (r.method ?? "GET") === method && r.url.test(url) && (used.get(r) ?? 0) < (r.times ?? Infinity),
    );
    if (!route) {
      throw new Error(`Unstubbed request: ${method} ${url}`);
    }
    used.set(route, (used.get(route) ?? 0) + 1);
    const body =
      typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {});
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  });
  return { fetch, calls };
}
