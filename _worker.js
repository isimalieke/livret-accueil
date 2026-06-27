/**
 * Cloudflare Pages — _worker.js
 * Gère uniquement /config.js (GET depuis KV, POST pour sauvegarder)
 * Tout le reste → fichiers statiques normaux
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Intercepter uniquement /config.js
    if (url.pathname === '/config.js') {

      if (request.method === 'GET') {
        try {
          const config = await env.CONFIG_KV.get('config');
          if (config) {
            return new Response('// WORKER-KV\n' + config, {
              headers: {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
              },
            });
          }
        } catch (e) {
          // KV non disponible → fichier statique
        }
        // Statique de démo — pas de cache
        const staticResp = await env.ASSETS.fetch(request);
        const h = new Headers(staticResp.headers);
        h.set('Cache-Control', 'no-store');
        return new Response(staticResp.body, { status: staticResp.status, headers: h });
      }

      if (request.method === 'POST') {
        try {
          const secret = request.headers.get('X-Auth-Secret');
          if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET) {
            return new Response(JSON.stringify({ ok: false, error: 'Non autorisé' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          const body = await request.text();
          if (!body || !body.includes('const CONFIG')) {
            return new Response(JSON.stringify({ ok: false, error: 'Contenu invalide' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          await env.CONFIG_KV.put('config', body);
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (e) {
          return new Response(JSON.stringify({ ok: false, error: String(e) }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // Toutes les autres URLs → fichiers statiques
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  },
};
