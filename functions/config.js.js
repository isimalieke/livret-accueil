/**
 * Cloudflare Pages Function — /config.js
 *
 * GET  → lit le config depuis KV et le sert comme script JS
 * POST → vérifie le secret, puis écrit le nouveau config dans KV
 *
 * Bindings requis (Cloudflare dashboard → Pages → Settings → Functions) :
 *   KV namespace : CONFIG_KV
 *   Variable d'env : AUTH_SECRET  (chaîne secrète, choisie par Isima à l'installation)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Secret',
};

// Pré-vol CORS (navigateurs modernes)
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

// Servir config.js depuis KV
export async function onRequestGet({ env }) {
  const config = await env.CONFIG_KV.get('config');
  if (!config) {
    return new Response(
      '// CONFIG non initialisée — ouvrez /admin.html et cliquez "Enregistrer en ligne"\n' +
      'const CONFIG = {}; if(typeof applyConfig==="function") applyConfig();',
      { status: 200, headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store', ...CORS } }
    );
  }
  return new Response(config, {
    status: 200,
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store', ...CORS }
  });
}

// Sauvegarder config.js dans KV
export async function onRequestPost({ request, env }) {
  const secret = request.headers.get('X-Auth-Secret');
  if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'Non autorisé' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  const body = await request.text();
  if (!body || !body.includes('const CONFIG')) {
    return new Response(JSON.stringify({ ok: false, error: 'Contenu invalide' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...CORS }
    });
  }

  await env.CONFIG_KV.put('config', body);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}
