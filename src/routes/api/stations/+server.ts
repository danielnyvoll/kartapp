// SvelteKit server endpoint (proxy) – ingen CORS i browseren
import type { RequestHandler } from '@sveltejs/kit';

const UPSTREAM = 'https://apim.unox.no/network/networks/stations';

export const GET: RequestHandler = async ({ url, fetch }) => {
  // Bare forward evt. query params videre, om du trenger
  const upstreamUrl = new URL(UPSTREAM);
  // Hvis du vil videreføre query: upstreamUrl.search = url.searchParams.toString();

  const r = await fetch(upstreamUrl.toString(), {
    method: 'GET',
    // legg på headere her om upstream krever noe (Auth etc)
    headers: {
      'accept': 'application/json'
    }
  });

  const body = await r.text(); // les rått (kan være {items:[]} eller [])
  return new Response(body, {
    status: r.status,
    headers: {
      'content-type': r.headers.get('content-type') ?? 'application/json',
      // litt caching – juster etter behov
      'cache-control': 'public, max-age=60'
    }
  });
};