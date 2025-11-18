// Proxy for geocoding (Nominatim). Unngår CORS og gir oss kontroll på headers/caching.
import type { RequestHandler } from '@sveltejs/kit';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export const GET: RequestHandler = async ({ url, fetch }) => {
  const q = url.searchParams.get('q');
  const limit = url.searchParams.get('limit') ?? '8';
  if (!q || q.trim().length < 2) {
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  // Bygg upstream-URL
  const u = new URL(NOMINATIM);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('addressdetails', '1');
  u.searchParams.set('limit', limit);
  // Du kan prioritere Norge ved å angi viewbox/bounded eller countrycodes=no:
  // u.searchParams.set('countrycodes', 'no');
  u.searchParams.set('q', q);

  const r = await fetch(u.toString(), {
    headers: {
      'accept': 'application/json',
      // Nominatim ønsker en identifiserbar User-Agent eller referer
      'user-agent': 'Unox-Map/1.0 (contact: it@unox.no)'
    }
  });

  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: {
      'content-type': r.headers.get('content-type') ?? 'application/json',
      // Litt cache for å være snill (juster etter behov)
      'cache-control': 'public, max-age=60'
    }
  });
};