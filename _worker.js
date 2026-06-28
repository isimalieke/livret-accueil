/**
 * Cloudflare Pages — _worker.js
 * Architecture multi-hôtel
 *
 * KV structure :
 *   hotel:{slug}:config   → const CONFIG = {...}; if(typeof applyConfig...)
 *   hotel:{slug}:auth     → JSON { nom, email, password, telephone, created }
 *   hotels:index          → JSON [{ slug, nom, email, created }]
 *
 * Routes :
 *   GET  /                       → register.html (page d'accueil SaaS)
 *   GET  /register               → register.html
 *   POST /register               → crée un compte hôtel dans KV
 *   GET  /{slug}                 → index.html (livret du voyageur)
 *   GET  /{slug}/                → index.html
 *   GET  /{slug}/config.js       → config depuis KV (réseau uniquement)
 *   POST /{slug}/config.js       → sauvegarde config (auth par mot de passe hôtel)
 *   GET  /{slug}/manifest.json   → manifest PWA dynamique (nom de l'hôtel)
 *   GET  /{slug}/admin           → admin.html
 *   GET  /{slug}/admin.html      → admin.html
 *   GET  /sw.js                  → sw.js statique
 *   GET  /*                      → fichiers statiques (icons, etc.)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Fichiers statiques à la racine (toujours passthrough) ──
    const ROOT_STATIC = ['/sw.js', '/manifest.json', '/favicon.ico'];
    if (ROOT_STATIC.includes(path) || path.startsWith('/icons/')) {
      return fetchAsset(env, request.url);
    }

    // ── /superadmin ──
    if (path === '/superadmin' || path === '/superadmin/') {
      return fetchAsset(env, url.origin + '/superadmin.html');
    }
    if (path === '/superadmin/hotels') {
      // Liste tous les hôtels (protégée par AUTH_SECRET maître)
      const secret = request.headers.get('X-Auth-Secret') || '';
      if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET) {
        return json({ ok: false, error: 'Non autorisé' }, 401);
      }
      const indexRaw = await env.CONFIG_KV.get('hotels:index') || '[]';
      const hotels = JSON.parse(indexRaw);
      return json({ ok: true, hotels });
    }

    // ── /register ──
    if (path === '/register' || path === '/register/') {
      if (request.method === 'POST') return handleRegister(request, env, url);
      return fetchAsset(env, url.origin + '/register.html');
    }

    // ── Racine → page d'inscription ──
    if (path === '/' || path === '') {
      return fetchAsset(env, url.origin + '/register.html');
    }

    // ── Extraire le slug ──
    const parts = path.split('/').filter(Boolean); // ['slug'] ou ['slug', 'subpath']
    const slug   = parts[0];
    const sub    = parts[1] || '';

    // Fichiers statiques servis normalement si le slug ressemble à un fichier
    if (slug.includes('.') && !sub) {
      return fetchAsset(env, request.url);
    }

    // ── /{slug}/config.js ──
    if (sub === 'config.js') {
      return handleConfig(request, env, slug);
    }

    // ── /{slug}/manifest.json ──
    if (sub === 'manifest.json') {
      return handleManifest(env, slug, url);
    }

    // ── /{slug}/admin ou /{slug}/admin.html ──
    if (sub === 'admin' || sub === 'admin.html') {
      return fetchAsset(env, url.origin + '/admin.html');
    }

    // ── /{slug}/carte → carte d'accueil imprimable ──
    if (sub === 'carte' || sub === 'carte.html') {
      return fetchAsset(env, url.origin + '/carte.html');
    }

    // ── /{slug}/incident → créer ticket ──
    if (sub === 'incident' && request.method === 'POST') {
      return handleCreateTicket(request, env, slug);
    }

    // ── /{slug}/tickets/search → recherche par téléphone ──
    if (sub === 'tickets' && parts[2] === 'search' && request.method === 'POST') {
      return handleSearchTickets(request, env, slug);
    }

    // ── /{slug}/tickets → liste (admin authentifié) ──
    if (sub === 'tickets' && !parts[2]) {
      return handleListTickets(request, env, slug);
    }

    // ── /{slug}/ticket/{id}[/action] ──
    if (sub === 'ticket' && parts[2]) {
      const ticketId = parts[2].toUpperCase();
      const action   = parts[3];
      if (action === 'data')                                   return handleGetTicketData(env, slug, ticketId);
      if (action === 'message' && request.method === 'POST')   return handleAddMessage(request, env, slug, ticketId);
      if (action === 'status'  && request.method === 'POST')   return handleUpdateStatus(request, env, slug, ticketId);
      // Sinon → page ticket.html
      return fetchAsset(env, url.origin + '/ticket.html');
    }

    // ── /{slug} ou /{slug}/ → livret voyageur ──
    if (parts.length <= 2) {
      return fetchAsset(env, url.origin + '/index.html');
    }

    // Tout le reste → statique
    return fetchAsset(env, request.url);
  },
};

// ─────────────────────────────────────────────
// INSCRIPTION AUTONOME
// ─────────────────────────────────────────────
async function handleRegister(request, env, url) {
  try {
    const data = await request.json();
    const { nom, email, password, ville, pays, adresse, telephone, whatsapp } = data;

    if (!nom || !email || !password) {
      return json({ ok: false, error: 'Champs obligatoires manquants (nom, email, password).' }, 400);
    }

    const slug = toSlug(nom);

    // Vérification doublon
    const existing = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
    if (existing) {
      return json({
        ok: false,
        error: 'Un établissement "' + nom + '" existe déjà. Contactez contact@assenka.com si c\'est le vôtre.',
      }, 409);
    }

    // Enregistrement compte
    await env.CONFIG_KV.put('hotel:' + slug + ':auth', JSON.stringify({
      nom,
      email,
      password,
      telephone: telephone || '',
      created: new Date().toISOString(),
    }));

    // Config initiale
    await env.CONFIG_KV.put(
      'hotel:' + slug + ':config',
      buildInitialConfig({ nom, ville, pays, adresse, telephone, whatsapp, email })
    );

    // Index global (liste tous les hôtels)
    const indexRaw = await env.CONFIG_KV.get('hotels:index') || '[]';
    const index = JSON.parse(indexRaw);
    index.push({ slug, nom, email, created: new Date().toISOString() });
    await env.CONFIG_KV.put('hotels:index', JSON.stringify(index));

    return json({ ok: true, slug, livretUrl: url.origin + '/' + slug });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ─────────────────────────────────────────────
// CONFIG.JS PAR HÔTEL
// ─────────────────────────────────────────────
async function handleConfig(request, env, slug) {
  // GET → sert la config depuis KV
  if (request.method === 'GET') {
    const config = await env.CONFIG_KV.get('hotel:' + slug + ':config');
    if (config) {
      return new Response('// WORKER-KV\n' + config, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store, no-cache',
        },
      });
    }
    // Compatibilité ascendante : ancien établissement unique
    const legacy = await env.CONFIG_KV.get('config');
    if (legacy) {
      return new Response('// WORKER-KV-LEGACY\n' + legacy, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store, no-cache',
        },
      });
    }
    // Aucune config → CONFIG vide pour éviter erreur JS
    return new Response(
      '// No config — setup via /' + slug + '/admin\nconst CONFIG={}; if(typeof applyConfig==="function") applyConfig();',
      { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  // POST → sauvegarde config (authentifié)
  if (request.method === 'POST') {
    const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
    if (!authRaw) return json({ ok: false, error: 'Hôtel introuvable : ' + slug }, 404);

    const auth   = JSON.parse(authRaw);
    const secret = request.headers.get('X-Auth-Secret') || '';

    // Accepte le mot de passe de l'hôtel OU le secret maître Assenka
    if (secret !== auth.password && secret !== env.AUTH_SECRET) {
      return json({ ok: false, error: 'Non autorisé' }, 401);
    }

    const body = await request.text();
    if (!body || !body.includes('const CONFIG')) {
      return json({ ok: false, error: 'Contenu invalide' }, 400);
    }

    await env.CONFIG_KV.put('hotel:' + slug + ':config', body);
    return json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ─────────────────────────────────────────────
// MANIFEST PWA DYNAMIQUE
// ─────────────────────────────────────────────
async function handleManifest(env, slug, url) {
  let nom = 'Livret d\'Accueil';
  const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
  if (authRaw) {
    try { nom = JSON.parse(authRaw).nom; } catch (_) {}
  }

  const manifest = {
    name: nom + ' · Livret d\'Accueil',
    short_name: nom.substring(0, 20),
    description: 'Livret d\'accueil digital de ' + nom,
    start_url: '/' + slug + '/',
    scope: '/' + slug + '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#2c3e50',
    background_color: '#f5f5f7',
    icons: [
      { src: url.origin + '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: url.origin + '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store',
    },
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function fetchAsset(env, urlString) {
  try {
    return await env.ASSETS.fetch(new Request(urlString));
  } catch (_) {
    return new Response('Not found', { status: 404 });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toSlug(nom) {
  return nom
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // supprimer accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

// ─────────────────────────────────────────────
// TICKETS D'INCIDENT
// KV : hotel:{slug}:ticket:{id}   → ticket complet
//      hotel:{slug}:tickets        → index [{id, status, subject, guestName, guestPhone, created}]
// ─────────────────────────────────────────────

function genTicketId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function handleCreateTicket(request, env, slug) {
  try {
    const data = await request.json();
    const { guestName, guestPhone, subject, message } = data;
    if (!subject || !message) return json({ ok: false, error: 'Objet et message requis.' }, 400);

    let id = genTicketId();
    let attempts = 0;
    while (await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + id) && attempts < 10) {
      id = genTicketId(); attempts++;
    }

    const ticket = {
      id, slug, status: 'received',
      guestName: guestName || 'Visiteur',
      guestPhone: guestPhone || '',
      subject,
      messages: [{ from: 'guest', text: message, timestamp: new Date().toISOString() }],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    await env.CONFIG_KV.put('hotel:' + slug + ':ticket:' + id, JSON.stringify(ticket));

    // Mise à jour index
    const indexRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
    const index = JSON.parse(indexRaw);
    index.unshift({ id, status: 'received', subject, guestName: ticket.guestName, guestPhone: ticket.guestPhone, created: ticket.created });
    await env.CONFIG_KV.put('hotel:' + slug + ':tickets', JSON.stringify(index));

    return json({ ok: true, id, ticketUrl: '/' + slug + '/ticket/' + id });
  } catch(e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetTicketData(env, slug, ticketId) {
  const raw = await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + ticketId);
  if (!raw) return json({ ok: false, error: 'Ticket introuvable' }, 404);
  return json({ ok: true, ticket: JSON.parse(raw) });
}

async function handleAddMessage(request, env, slug, ticketId) {
  try {
    const raw = await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + ticketId);
    if (!raw) return json({ ok: false, error: 'Ticket introuvable' }, 404);
    const ticket = JSON.parse(raw);
    const data = await request.json();
    const { text, from, auth } = data;
    if (!text) return json({ ok: false, error: 'Message vide' }, 400);

    // Messages hôtel → authentification obligatoire
    if (from === 'hotel') {
      const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
      if (!authRaw) return json({ ok: false, error: 'Hôtel introuvable' }, 404);
      const hotelAuth = JSON.parse(authRaw);
      if (auth !== hotelAuth.password && auth !== env.AUTH_SECRET)
        return json({ ok: false, error: 'Non autorisé' }, 401);
    }

    ticket.messages.push({ from: from || 'guest', text, timestamp: new Date().toISOString() });
    ticket.updated = new Date().toISOString();

    // Hôtel répond → passe automatiquement à "en traitement"
    if (from === 'hotel' && ticket.status === 'received') {
      ticket.status = 'in_progress';
      const indexRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
      const index = JSON.parse(indexRaw);
      const idx = index.findIndex(function(t) { return t.id === ticketId; });
      if (idx >= 0) index[idx].status = 'in_progress';
      await env.CONFIG_KV.put('hotel:' + slug + ':tickets', JSON.stringify(index));
    }

    await env.CONFIG_KV.put('hotel:' + slug + ':ticket:' + ticketId, JSON.stringify(ticket));
    return json({ ok: true, ticket });
  } catch(e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleUpdateStatus(request, env, slug, ticketId) {
  try {
    const raw = await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + ticketId);
    if (!raw) return json({ ok: false, error: 'Ticket introuvable' }, 404);
    const ticket = JSON.parse(raw);
    const data = await request.json();
    const { status, auth } = data;

    const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
    if (!authRaw) return json({ ok: false, error: 'Hôtel introuvable' }, 404);
    const hotelAuth = JSON.parse(authRaw);
    if (auth !== hotelAuth.password && auth !== env.AUTH_SECRET)
      return json({ ok: false, error: 'Non autorisé' }, 401);

    const valid = ['received', 'in_progress', 'resolved'];
    if (!valid.includes(status)) return json({ ok: false, error: 'Statut invalide' }, 400);

    ticket.status = status;
    ticket.updated = new Date().toISOString();
    await env.CONFIG_KV.put('hotel:' + slug + ':ticket:' + ticketId, JSON.stringify(ticket));

    const indexRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
    const index = JSON.parse(indexRaw);
    const idx = index.findIndex(function(t) { return t.id === ticketId; });
    if (idx >= 0) index[idx].status = status;
    await env.CONFIG_KV.put('hotel:' + slug + ':tickets', JSON.stringify(index));

    return json({ ok: true, ticket });
  } catch(e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleListTickets(request, env, slug) {
  const secret = request.headers.get('X-Auth-Secret') || '';
  const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
  if (!authRaw) return json({ ok: false, error: 'Hôtel introuvable' }, 404);
  const hotelAuth = JSON.parse(authRaw);
  if (secret !== hotelAuth.password && secret !== env.AUTH_SECRET)
    return json({ ok: false, error: 'Non autorisé' }, 401);
  const indexRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
  return json({ ok: true, tickets: JSON.parse(indexRaw) });
}

async function handleSearchTickets(request, env, slug) {
  try {
    const body = await request.json();
    const { phone } = body;
    if (!phone) return json({ ok: false, error: 'Téléphone requis' }, 400);
    const indexRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
    const index = JSON.parse(indexRaw);
    const clean = function(p) { return p.replace(/[\s\-\(\)]/g, ''); };
    const matches = index.filter(function(t) {
      return t.guestPhone && clean(t.guestPhone).includes(clean(phone));
    });
    return json({ ok: true, tickets: matches });
  } catch(e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

function buildInitialConfig({ nom, ville, pays, adresse, telephone, whatsapp, email }) {
  const esc = (s) => JSON.stringify(s || '');
  return `const CONFIG = {
  hotel: {
    nom:         ${esc(nom)},
    nom_court:   ${esc(nom.substring(0, 20))},
    ville:       ${esc(ville || 'Dakar')},
    pays:        ${esc(pays || 'Sénégal')},
    adresse:     ${esc(adresse || '')},
    telephone:   ${esc(telephone || '')},
    whatsapp:    ${esc(whatsapp || telephone || '')},
    email:       ${esc(email || '')},
    hote_nom:    "",
    logo_url:    "",
    cover_photo: "",
  },
  bienvenue: {
    texte_fr:  "Bienvenue dans notre établissement.",
    texte_en:  "Welcome to our establishment.",
    signature: "L'équipe",
  },
  pratique: {
    wifi_reseau: "", wifi_mdp: "",
    checkin: "14h00", checkout: "11h00",
    cles:    "Déposez les clés à la réception",
    cles_en: "Leave keys at reception",
    regles:  [],
  },
  appareils: { clim_fr:"", clim_en:"", tv_fr:"", tv_en:"", chauffe_fr:"", chauffe_en:"", groupe_fr:"", groupe_en:"" },
  services:  { inclus: [], sur_demande: [] },
  restaurants: { senegalais: [], international: [], a_gouter: [] },
  quartier:  { points: [], commerces: [] },
  transport: { vtc: [], commun: [], location: [] },
  plages:    { plages: [], activites: [] },
  shopping:  { marches: [] },
  medical:   { urgences: [], cliniques: [] },
  securite:  { urgences: [] },
  ambassades: [],
  paiement:  {},
  checkout:  {
    heure:    "11h00",
    heure_en: "11:00 AM",
    cles_fr:  "Déposez les clés à la réception",
    cles_en:  "Leave keys at reception",
  },
  avis:    {},
  acces:   { actif: false, mot_de_passe: "" },
};
if (typeof applyConfig === 'function') applyConfig();`;
}
