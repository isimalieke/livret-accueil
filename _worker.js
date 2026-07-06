/**
 * Cloudflare Pages — _worker.js
 * Architecture multi-hôtel
 *
 * Bindings requis :
 *   CONFIG_KV  → KV namespace (config.js par hôtel + séjours en cours)
 *   DB         → D1 database (hôtels, utilisateurs, tickets, messages)
 *   RESEND_API_KEY → secret Resend
 *   JWT_SECRET     → secret de signature JWT (min 32 caractères)
 *   AUTH_SECRET    → secret superadmin (inchangé)
 *
 * Rôles :
 *   superadmin  → AUTH_SECRET (vous, Isima)
 *   hotelier    → JWT role='hotelier'
 *   gestionnaire→ JWT role='gestionnaire' (délégué par l'hôtelier)
 *   vacancier   → pas d'auth (accès livret + tickets publics)
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Fichiers statiques racine ──
    const ROOT_STATIC = ['/sw.js', '/manifest.json', '/favicon.ico'];
    if (ROOT_STATIC.includes(path) || path.startsWith('/icons/')) {
      return fetchAsset(env, request.url);
    }

    // ── /superadmin ──
    if (path === '/superadmin' || path === '/superadmin/') {
      return fetchAsset(env, url.origin + '/superadmin.html');
    }
    if (path === '/superadmin/hotels') {
      const secret = request.headers.get('X-Auth-Secret') || '';
      if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET)
        return json({ ok: false, error: 'Non autorisé' }, 401);
      const hotels = await env.DB.prepare('SELECT slug, nom, ville, created_at FROM hotels ORDER BY created_at DESC').all();
      return json({ ok: true, hotels: hotels.results });
    }
    if (path === '/superadmin/migrate-to-d1' && request.method === 'POST') {
      return handleMigrateToD1(request, env);
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
    const parts = path.split('/').filter(Boolean);
    const slug  = parts[0];
    const sub   = parts[1] || '';

    if (slug.includes('.') && !sub) return fetchAsset(env, request.url);

    // ── /{slug}/config.js ──
    if (sub === 'config.js') return handleConfig(request, env, slug);

    // ── /{slug}/manifest.json ──
    if (sub === 'manifest.json') return handleManifest(env, slug, url);

    // ── /{slug}/admin ──
    if (sub === 'admin' || sub === 'admin.html') {
      return fetchAsset(env, url.origin + '/admin.html');
    }

    // ── /{slug}/gestion ──
    if (sub === 'gestion' || sub === 'gestion.html') {
      return fetchAsset(env, url.origin + '/gestion.html');
    }

    // ── /{slug}/carte ──
    if (sub === 'carte' || sub === 'carte.html') {
      return fetchAsset(env, url.origin + '/carte.html');
    }

    // ── /{slug}/auth/login ──
    if (sub === 'auth' && parts[2] === 'login' && request.method === 'POST') {
      return handleLogin(request, env, slug);
    }

    // ── /{slug}/auth/forgot-password ──
    if (sub === 'auth' && parts[2] === 'forgot-password' && request.method === 'POST') {
      return handleForgotPassword(request, env, slug, url);
    }

    // ── /{slug}/auth/reset ──
    if (sub === 'auth' && parts[2] === 'reset') {
      if (request.method === 'GET') return fetchAsset(env, url.origin + '/reset.html');
      if (request.method === 'POST') return handleResetPassword(request, env, slug);
    }

    // ── /{slug}/gestionnaire (CRUD délégation) ──
    if (sub === 'gestionnaire') {
      if (request.method === 'POST' && !parts[2])
        return handleCreateGestionnaire(request, env, slug);
      if (request.method === 'DELETE' && parts[2])
        return handleRevokeGestionnaire(request, env, slug, parts[2]);
      if (request.method === 'GET' && !parts[2])
        return handleListGestionnaires(request, env, slug);
    }

    // ── /{slug}/incident ──
    if (sub === 'incident' && request.method === 'POST') {
      return handleCreateTicket(request, env, slug);
    }

    // ── /{slug}/guest-stay ──
    if (sub === 'guest-stay' && request.method === 'POST') {
      return handleSaveGuestStay(request, env, slug);
    }

    // ── /{slug}/tickets/search ──
    if (sub === 'tickets' && parts[2] === 'search' && request.method === 'POST') {
      return handleSearchTickets(request, env, slug);
    }

    // ── /{slug}/tickets ──
    if (sub === 'tickets' && !parts[2]) {
      return handleListTickets(request, env, slug);
    }

    // ── /{slug}/ticket/{id}[/action] ──
    if (sub === 'ticket' && parts[2]) {
      const ticketId = parts[2].toUpperCase();
      const action   = parts[3];
      if (action === 'data')                                 return handleGetTicketData(env, slug, ticketId);
      if (action === 'message' && request.method === 'POST') return handleAddMessage(request, env, slug, ticketId);
      if (action === 'status'  && request.method === 'POST') return handleUpdateStatus(request, env, slug, ticketId);
      return fetchAsset(env, url.origin + '/ticket.html');
    }

    // ── /{slug} ou /{slug}/ ──
    if (parts.length <= 2) return fetchAsset(env, url.origin + '/index.html');

    return fetchAsset(env, request.url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckoutReminders(env));
  },
};

// ═════════════════════════════════════════════
// CRYPTO — PBKDF2 + JWT
// ═════════════════════════════════════════════

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const saltHex = hex(salt);
  const hashHex = hex(new Uint8Array(bits));
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  // Compatibilité ascendante : anciens mots de passe en clair (KV)
  if (!stored || !stored.startsWith('pbkdf2:')) return password === stored;
  const [, saltHex, hashHex] = stored.split(':');
  const salt = unhex(saltHex);
  const key  = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  return hex(new Uint8Array(bits)) === hashHex;
}

function b64u(str) { return btoa(str).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function b64uDec(str) { return atob(str.replace(/-/g,'+').replace(/_/g,'/')); }

async function signJWT(payload, env) {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET manquant');
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64u(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    'raw', enc(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig    = await crypto.subtle.sign('HMAC', key, enc(data));
  const sigB64 = b64u(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigB64}`;
}

async function verifyJWT(token, env) {
  if (!token || !env.JWT_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const key  = await crypto.subtle.importKey(
    'raw', enc(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  try {
    const sig   = Uint8Array.from(b64uDec(parts[2]), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc(data));
    if (!valid) return null;
    const payload = JSON.parse(b64uDec(parts[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function getToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// Vérifie qu'un JWT valide existe et concerne le bon hôtel
// roles : tableau de rôles acceptés, ex. ['hotelier'] ou ['hotelier','gestionnaire']
async function requireAuth(request, env, slug, roles = ['hotelier', 'gestionnaire']) {
  // Superadmin contourne tout
  const secret = request.headers.get('X-Auth-Secret') || '';
  if (env.AUTH_SECRET && secret === env.AUTH_SECRET)
    return { ok: true, payload: { role: 'superadmin', slug } };

  const token   = getToken(request);
  const payload = await verifyJWT(token, env);
  if (!payload) return { ok: false, response: json({ ok: false, error: 'Non authentifié' }, 401) };
  if (payload.slug !== slug) return { ok: false, response: json({ ok: false, error: 'Accès interdit' }, 403) };
  if (!roles.includes(payload.role)) return { ok: false, response: json({ ok: false, error: 'Droits insuffisants' }, 403) };
  return { ok: true, payload };
}

// ═════════════════════════════════════════════
// AUTH — LOGIN
// ═════════════════════════════════════════════

async function handleLogin(request, env, slug) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return json({ ok: false, error: 'Email et mot de passe requis' }, 400);

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE hotel_slug = ? AND email = ? AND active = 1'
    ).bind(slug, email.toLowerCase().trim()).first();

    if (!user || !(await verifyPassword(password, user.password_hash)))
      return json({ ok: false, error: 'Email ou mot de passe incorrect' }, 401);

    const token = await signJWT({
      sub:  user.id,
      slug,
      role: user.role,
      nom:  user.nom,
      exp:  Math.floor(Date.now() / 1000) + 86400 * 30, // 30 jours
    }, env);

    return json({ ok: true, token, role: user.role, nom: user.nom });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// MOT DE PASSE OUBLIÉ
// ═════════════════════════════════════════════

async function handleForgotPassword(request, env, slug, url) {
  try {
    const { email } = await request.json();
    if (!email) return json({ ok: false, error: 'Email requis' }, 400);

    const user = await env.DB.prepare(
      'SELECT id, nom, email FROM users WHERE hotel_slug = ? AND email = ? AND active = 1'
    ).bind(slug, email.toLowerCase().trim()).first();

    // Réponse identique qu'il existe ou non (anti-énumération)
    if (!user) return json({ ok: true });

    // Générer un token aléatoire 32 octets
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    // Stocker dans KV avec TTL 1 heure
    await env.CONFIG_KV.put(
      'reset:' + token,
      JSON.stringify({ userId: user.id, email: user.email, slug }),
      { expirationTtl: 3600 }
    );

    // Envoyer l'email
    if (env.RESEND_API_KEY) {
      const resetUrl = `${url.origin}/${slug}/auth/reset?token=${token}`;
      await sendPasswordResetEmail(env, user, resetUrl);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleResetPassword(request, env, slug) {
  try {
    const { token, password } = await request.json();
    if (!token || !password) return json({ ok: false, error: 'Token et mot de passe requis' }, 400);
    if (password.length < 8) return json({ ok: false, error: 'Mot de passe trop court (min 8 caractères)' }, 400);

    // Récupérer le token dans KV
    const stored = await env.CONFIG_KV.get('reset:' + token);
    if (!stored) return json({ ok: false, error: 'Lien invalide ou expiré' }, 400);

    const { userId, slug: tokenSlug } = JSON.parse(stored);
    if (tokenSlug !== slug) return json({ ok: false, error: 'Lien invalide' }, 400);

    // Mettre à jour le mot de passe en D1
    const newHash = await hashPassword(password);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, userId).run();

    // Invalider le token
    await env.CONFIG_KV.delete('reset:' + token);

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// GESTIONNAIRES (délégation)
// ═════════════════════════════════════════════

async function handleCreateGestionnaire(request, env, slug) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;

  try {
    const { nom, email, password } = await request.json();
    if (!nom || !email || !password) return json({ ok: false, error: 'nom, email et password requis' }, 400);

    // Vérifier doublon
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE hotel_slug = ? AND email = ?'
    ).bind(slug, email.toLowerCase().trim()).first();
    if (existing) return json({ ok: false, error: 'Cet email est déjà utilisé pour cet hôtel' }, 409);

    const id           = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    await env.DB.prepare(
      'INSERT INTO users (id, hotel_slug, nom, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,1,?)'
    ).bind(id, slug, nom, email.toLowerCase().trim(), passwordHash, 'gestionnaire', new Date().toISOString()).run();

    return json({ ok: true, id, nom, email });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleRevokeGestionnaire(request, env, slug, userId) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;

  try {
    await env.DB.prepare(
      'UPDATE users SET active = 0 WHERE id = ? AND hotel_slug = ? AND role = ?'
    ).bind(userId, slug, 'gestionnaire').run();
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleListGestionnaires(request, env, slug) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;

  try {
    const result = await env.DB.prepare(
      'SELECT id, nom, email, active, created_at FROM users WHERE hotel_slug = ? AND role = ? ORDER BY created_at DESC'
    ).bind(slug, 'gestionnaire').all();
    return json({ ok: true, gestionnaires: result.results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// INSCRIPTION
// ═════════════════════════════════════════════

async function handleRegister(request, env, url) {
  try {
    const data = await request.json();
    const { nom, email, password, ville, pays, adresse, telephone, whatsapp } = data;

    if (!nom || !email || !password)
      return json({ ok: false, error: 'Champs obligatoires manquants (nom, email, password).' }, 400);

    const slug = toSlug(nom);

    // Vérifier doublon dans D1
    const existing = await env.DB.prepare('SELECT slug FROM hotels WHERE slug = ?').bind(slug).first();
    if (existing)
      return json({ ok: false, error: `Un établissement "${nom}" existe déjà.` }, 409);

    const now          = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    const userId       = crypto.randomUUID();

    // Créer l'hôtel
    await env.DB.prepare(
      'INSERT INTO hotels (slug, nom, ville, pays, adresse, telephone, whatsapp, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(slug, nom, ville||'', pays||'', adresse||'', telephone||'', whatsapp||'', now).run();

    // Créer l'utilisateur hôtelier
    await env.DB.prepare(
      'INSERT INTO users (id, hotel_slug, nom, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,1,?)'
    ).bind(userId, slug, nom, email.toLowerCase().trim(), passwordHash, 'hotelier', now).run();

    // Config initiale dans KV (inchangé)
    await env.CONFIG_KV.put(
      'hotel:' + slug + ':config',
      buildInitialConfig({ nom, ville, pays, adresse, telephone, whatsapp, email })
    );

    // Générer un token directement après inscription
    const token = await signJWT({
      sub: userId, slug, role: 'hotelier', nom, exp: Math.floor(Date.now()/1000) + 86400*30,
    }, env);

    // Email de bienvenue (non bloquant)
    if (env.RESEND_API_KEY) {
      sendWelcomeEmail(env, { nom, email: email.toLowerCase().trim(), slug }, url.origin).catch(() => {});
    }

    return json({ ok: true, slug, livretUrl: url.origin + '/' + slug, token });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// CONFIG.JS (KV — inchangé)
// ═════════════════════════════════════════════

async function handleConfig(request, env, slug) {
  if (request.method === 'GET') {
    const config = await env.CONFIG_KV.get('hotel:' + slug + ':config');
    if (config) {
      return new Response('// WORKER-KV\n' + config, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, no-cache' },
      });
    }
    return new Response(
      '// No config — setup via /' + slug + '/admin\nconst CONFIG={}; if(typeof applyConfig==="function") applyConfig();',
      { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }

  if (request.method === 'POST') {
    // Seul l'hôtelier peut modifier la config
    const auth = await requireAuth(request, env, slug, ['hotelier']);
    if (!auth.ok) return auth.response;

    const body = await request.text();
    if (!body || !body.includes('const CONFIG'))
      return json({ ok: false, error: 'Contenu invalide' }, 400);

    await env.CONFIG_KV.put('hotel:' + slug + ':config', body);
    return json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ═════════════════════════════════════════════
// MANIFEST PWA
// ═════════════════════════════════════════════

async function handleManifest(env, slug, url) {
  let nom = 'Livret d\'Accueil';
  try {
    const hotel = await env.DB.prepare('SELECT nom FROM hotels WHERE slug = ?').bind(slug).first();
    if (hotel) nom = hotel.nom;
  } catch (_) {}

  const manifest = {
    name: nom,
    short_name: nom.substring(0, 20),
    start_url: '/' + slug,
    display: 'standalone',
    background_color: '#1a3a5c',
    theme_color: '#1a3a5c',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
  });
}

// ═════════════════════════════════════════════
// TICKETS D'INCIDENT
// ═════════════════════════════════════════════

function genTicketId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

async function handleCreateTicket(request, env, slug) {
  try {
    const data = await request.json();
    const { guestName, guestPhone, guestEmail, guestRoom, subject, message } = data;
    if (!subject || !message) return json({ ok: false, error: 'Objet et message requis.' }, 400);

    // Générer un ID unique
    let id, attempts = 0;
    do {
      id = genTicketId();
      const exists = await env.DB.prepare('SELECT id FROM tickets WHERE id = ?').bind(id).first();
      if (!exists) break;
    } while (++attempts < 10);

    const now = new Date().toISOString();
    const name = guestName || 'Visiteur';

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO tickets (id, hotel_slug, guest_name, guest_email, guest_phone, guest_room, subject, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
      ).bind(id, slug, name, guestEmail||'', guestPhone||'', guestRoom||'', subject, 'received', now, now),
      env.DB.prepare(
        'INSERT INTO messages (ticket_id, from_role, from_user_id, text, created_at) VALUES (?,?,null,?,?)'
      ).bind(id, 'guest', message, now),
    ]);

    // Récupérer infos hôtel pour les emails
    const hotel = await env.DB.prepare('SELECT nom FROM hotels WHERE slug = ?').bind(slug).first();
    const hotelNom = hotel ? hotel.nom : slug;
    const configRaw = await env.CONFIG_KV.get('hotel:' + slug + ':config') || '';
    const emailMatch = configRaw.match(/email\s*:\s*["']([^"']+)["']/);
    const hotelEmail = emailMatch ? emailMatch[1] : '';

    // Construire le ticket complet pour les emails
    const ticketForEmail = {
      id, slug, subject,
      guestName: name, guestPhone: guestPhone||'', guestEmail: guestEmail||'',
      status: 'received', created: now,
      messages: [{ from: 'guest', text: message, timestamp: now }],
    };

    let emailSent = false;
    if (guestEmail && env.RESEND_API_KEY) {
      const r = await sendTicketConfirmationToGuest(env, ticketForEmail, hotelNom, slug);
      emailSent = r && r.status === 200;
    }
    if (hotelEmail && env.RESEND_API_KEY) {
      await sendTicketNotificationToHotel(env, ticketForEmail, hotelNom, hotelEmail, message, slug);
    }

    return json({ ok: true, id, ticketUrl: '/' + slug + '/ticket/' + id, emailSent });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetTicketData(env, slug, ticketId) {
  try {
    const ticket = await env.DB.prepare(
      'SELECT * FROM tickets WHERE id = ? AND hotel_slug = ?'
    ).bind(ticketId, slug).first();
    if (!ticket) return json({ ok: false, error: 'Ticket introuvable' }, 404);

    const msgs = await env.DB.prepare(
      'SELECT id, from_role AS "from", from_user_id, text, created_at AS timestamp FROM messages WHERE ticket_id = ? ORDER BY created_at ASC'
    ).bind(ticketId).all();

    return json({
      ok: true,
      ticket: {
        id:         ticket.id,
        slug:       ticket.hotel_slug,
        status:     ticket.status,
        subject:    ticket.subject,
        guestName:  ticket.guest_name,
        guestPhone: ticket.guest_phone,
        guestEmail: ticket.guest_email,
        guestRoom:  ticket.guest_room,
        created:    ticket.created_at,
        updated:    ticket.updated_at,
        messages:   msgs.results,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleAddMessage(request, env, slug, ticketId) {
  try {
    const ticket = await env.DB.prepare(
      'SELECT * FROM tickets WHERE id = ? AND hotel_slug = ?'
    ).bind(ticketId, slug).first();
    if (!ticket) return json({ ok: false, error: 'Ticket introuvable' }, 404);

    const data = await request.json();
    const { text, from } = data;
    if (!text) return json({ ok: false, error: 'Message vide' }, 400);

    let fromUserId = null;

    // Messages hôtel → authentification obligatoire
    if (from === 'hotel') {
      const auth = await requireAuth(request, env, slug, ['hotelier', 'gestionnaire']);
      if (!auth.ok) return auth.response;
      fromUserId = auth.payload.sub || null;
    }

    const now = new Date().toISOString();

    // Insérer le message
    await env.DB.prepare(
      'INSERT INTO messages (ticket_id, from_role, from_user_id, text, created_at) VALUES (?,?,?,?,?)'
    ).bind(ticketId, from || 'guest', fromUserId, text, now).run();

    // Passer à "en cours" si premier message hôtel sur un ticket nouveau
    if (from === 'hotel' && ticket.status === 'received') {
      await env.DB.prepare(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('in_progress', now, ticketId).run();
    } else {
      await env.DB.prepare(
        'UPDATE tickets SET updated_at = ? WHERE id = ?'
      ).bind(now, ticketId).run();
    }

    // Récupérer le ticket mis à jour pour les emails
    const updatedTicket = await handleGetTicketData(env, slug, ticketId);
    const ticketData = (await updatedTicket.json()).ticket;

    // Notifications
    if (env.RESEND_API_KEY) {
      const hotel = await env.DB.prepare('SELECT nom FROM hotels WHERE slug = ?').bind(slug).first();
      const hotelNom = hotel ? hotel.nom : slug;
      const configRaw = await env.CONFIG_KV.get('hotel:' + slug + ':config') || '';
      const emailMatch = configRaw.match(/email\s*:\s*["']([^"']+)["']/);
      const hotelEmail = emailMatch ? emailMatch[1] : '';

      if (from === 'guest' && hotelEmail) {
        await sendTicketNotificationToHotel(env, ticketData, hotelNom, hotelEmail, text, slug);
      } else if (from === 'hotel' && ticketData.guestEmail) {
        await sendTicketReplyToGuest(env, ticketData, hotelNom, text, slug);
      }
    }

    return json({ ok: true, ticket: ticketData });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleUpdateStatus(request, env, slug, ticketId) {
  try {
    const auth = await requireAuth(request, env, slug, ['hotelier', 'gestionnaire']);
    if (!auth.ok) return auth.response;

    const { status } = await request.json();
    const valid = ['received', 'in_progress', 'resolved'];
    if (!valid.includes(status)) return json({ ok: false, error: 'Statut invalide' }, 400);

    const ticket = await env.DB.prepare(
      'SELECT id FROM tickets WHERE id = ? AND hotel_slug = ?'
    ).bind(ticketId, slug).first();
    if (!ticket) return json({ ok: false, error: 'Ticket introuvable' }, 404);

    await env.DB.prepare(
      'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(status, new Date().toISOString(), ticketId).run();

    return json({ ok: true, status });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleListTickets(request, env, slug) {
  const auth = await requireAuth(request, env, slug, ['hotelier', 'gestionnaire']);
  if (!auth.ok) return auth.response;

  try {
    const tickets = await env.DB.prepare(
      `SELECT id, status, subject,
              guest_name AS guestName, guest_phone AS guestPhone, guest_email AS guestEmail,
              created_at AS created
       FROM tickets WHERE hotel_slug = ? ORDER BY created_at DESC`
    ).bind(slug).all();
    return json({ ok: true, tickets: tickets.results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleSearchTickets(request, env, slug) {
  try {
    const { phone } = await request.json();
    if (!phone) return json({ ok: false, error: 'Téléphone requis' }, 400);
    // Recherche partielle (sans espaces/tirets)
    const clean = phone.replace(/[\s\-\(\)]/g, '');
    const all = await env.DB.prepare(
      'SELECT id, status, subject, guest_name AS guestName, guest_phone AS guestPhone, created_at AS created FROM tickets WHERE hotel_slug = ?'
    ).bind(slug).all();
    const matches = all.results.filter(t =>
      t.guestPhone && t.guestPhone.replace(/[\s\-\(\)]/g, '').includes(clean)
    );
    return json({ ok: true, tickets: matches });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// SÉJOUR EN COURS (KV — inchangé)
// ═════════════════════════════════════════════

async function handleSaveGuestStay(request, env, slug) {
  const secret = request.headers.get('X-Auth-Secret') || '';
  const token  = getToken(request);
  const payload = await verifyJWT(token, env);
  const isSuperAdmin = env.AUTH_SECRET && secret === env.AUTH_SECRET;
  const isHotelier   = payload && payload.slug === slug && payload.role === 'hotelier';
  if (!isSuperAdmin && !isHotelier)
    return json({ ok: false, error: 'Non autorisé' }, 401);

  try {
    const { nom, email, checkout } = await request.json();
    if (!email || !checkout) return json({ ok: false, error: 'Email et date de checkout requis' }, 400);
    await env.CONFIG_KV.put(
      `hotel:${slug}:current_stay`,
      JSON.stringify({ nom: nom||'', email, checkout, saved: new Date().toISOString() })
    );
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ═════════════════════════════════════════════
// MIGRATION KV → D1
// ═════════════════════════════════════════════

async function handleMigrateToD1(request, env) {
  const secret = request.headers.get('X-Auth-Secret') || '';
  if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET)
    return json({ ok: false, error: 'Non autorisé' }, 401);

  const results = { hotels: 0, users: 0, tickets: 0, messages: 0, errors: [] };

  try {
    const indexRaw = await env.CONFIG_KV.get('hotels:index') || '[]';
    const hotels   = JSON.parse(indexRaw);

    for (const h of hotels) {
      try {
        const slug    = h.slug;
        const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
        if (!authRaw) continue;
        const auth = JSON.parse(authRaw);

        // Vérifier si déjà migré
        const existing = await env.DB.prepare('SELECT slug FROM hotels WHERE slug = ?').bind(slug).first();
        if (!existing) {
          await env.DB.prepare(
            'INSERT INTO hotels (slug, nom, ville, pays, adresse, telephone, whatsapp, created_at) VALUES (?,?,?,?,?,?,?,?)'
          ).bind(slug, auth.nom||slug, '', '', '', auth.telephone||'', '', auth.created||new Date().toISOString()).run();
          results.hotels++;

          // Hacher le mot de passe avant stockage
          const passwordHash = await hashPassword(auth.password);
          await env.DB.prepare(
            'INSERT INTO users (id, hotel_slug, nom, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?,1,?)'
          ).bind(crypto.randomUUID(), slug, auth.nom||slug, auth.email||'', passwordHash, 'hotelier', auth.created||new Date().toISOString()).run();
          results.users++;
        }

        // Migrer les tickets
        const ticketsRaw = await env.CONFIG_KV.get('hotel:' + slug + ':tickets') || '[]';
        const ticketIndex = JSON.parse(ticketsRaw);

        for (const ti of ticketIndex) {
          try {
            const tRaw = await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + ti.id);
            if (!tRaw) continue;
            const t = JSON.parse(tRaw);

            const existsT = await env.DB.prepare('SELECT id FROM tickets WHERE id = ?').bind(t.id).first();
            if (existsT) continue;

            await env.DB.prepare(
              'INSERT INTO tickets (id, hotel_slug, guest_name, guest_email, guest_phone, guest_room, subject, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
            ).bind(t.id, slug, t.guestName||'Visiteur', t.guestEmail||'', t.guestPhone||'', t.guestRoom||'', t.subject, t.status||'received', t.created, t.updated||t.created).run();
            results.tickets++;

            for (const m of (t.messages || [])) {
              await env.DB.prepare(
                'INSERT INTO messages (ticket_id, from_role, from_user_id, text, created_at) VALUES (?,?,null,?,?)'
              ).bind(t.id, m.from||'guest', m.text, m.timestamp).run();
              results.messages++;
            }
          } catch (e) { results.errors.push(`ticket ${ti.id}: ${e.message}`); }
        }
      } catch (e) { results.errors.push(`hotel ${h.slug}: ${e.message}`); }
    }

    return json({ ok: true, ...results });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ═════════════════════════════════════════════
// CRON — RAPPELS CHECK-OUT
// ═════════════════════════════════════════════

async function runCheckoutReminders(env) {
  if (!env.RESEND_API_KEY) return;
  const tomorrow    = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  try {
    const hotels = await env.DB.prepare('SELECT slug, nom FROM hotels').all();
    for (const h of hotels.results) {
      try {
        const stayRaw = await env.CONFIG_KV.get(`hotel:${h.slug}:current_stay`);
        if (!stayRaw) continue;
        const stay = JSON.parse(stayRaw);
        if (stay.checkout !== tomorrowStr) continue;
        await sendCheckoutReminder(env, stay, h.nom, h.slug);
        await env.CONFIG_KV.delete(`hotel:${h.slug}:current_stay`);
      } catch (_) {}
    }
  } catch (_) {}
}

async function sendCheckoutReminder(env, stay, hotelNom, slug) {
  const guestNom = stay.nom || 'Cher(e) hôte';
  const dateStr  = new Date(stay.checkout + 'T12:00:00').toLocaleDateString('fr-FR', {
    weekday:'long', day:'numeric', month:'long'
  });

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><style>
body{margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.wrap{max-width:540px;margin:32px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.cover{background:linear-gradient(135deg,#1a3a5c 0%,#2c6ea1 100%);padding:36px 32px 28px;text-align:center}
.cover-ico{font-size:48px;margin-bottom:10px}.cover-hotel{color:#fff;font-size:24px;font-weight:700}
.cover-sub{color:rgba(255,255,255,.7);font-size:13px}
.body{padding:32px}.greeting{font-size:17px;color:#1a3a5c;font-weight:600;margin-bottom:8px}
.intro{font-size:15px;color:#555;line-height:1.6;margin-bottom:24px}
.item{display:flex;align-items:flex-start;gap:12px;margin-bottom:13px}
.item-num{width:28px;height:28px;border-radius:50%;background:#1a3a5c;color:#fff;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.item-text{font-size:14px;color:#444;line-height:1.5;padding-top:5px}
.checkout-box{background:#f0fdf4;border:1px solid #86efac;border-radius:14px;padding:18px 20px;margin:24px 0;text-align:center}
.checkout-time{font-size:32px;font-weight:700;color:#15803d}.checkout-label{font-size:13px;color:#15803d;margin-top:4px}
.footer{background:#1a3a5c;padding:22px 32px;text-align:center}
.footer-thanks{color:#fff;font-size:18px;margin-bottom:8px}.footer-sub{color:rgba(255,255,255,.6);font-size:12px}
</style></head><body><div class="wrap">
<div class="cover"><div class="cover-ico">🌅</div><div class="cover-hotel">${hotelNom}</div><div class="cover-sub">Votre check-out est demain</div></div>
<div class="body">
<div class="greeting">Bonjour ${guestNom},</div>
<div class="intro">Votre séjour touche bientôt à sa fin. Nous avons été ravis de vous recevoir.<br><br>Voici nos derniers conseils :</div>
<div class="item"><div class="item-num">1</div><div class="item-text">Vérifiez que vous n'avez rien oublié — armoires, tiroirs, salle de bain, chargeurs</div></div>
<div class="item"><div class="item-num">2</div><div class="item-text">Éteignez les lumières et la climatisation</div></div>
<div class="item"><div class="item-num">3</div><div class="item-text">Fermez toutes les fenêtres et portes</div></div>
<div class="item"><div class="item-num">4</div><div class="item-text">Déposez vos clés selon les instructions reçues à l'arrivée</div></div>
<div class="item"><div class="item-num">5</div><div class="item-text">N'hésitez pas à nous contacter si vous avez besoin de garder vos bagages</div></div>
<div class="checkout-box"><div class="checkout-label">Heure limite de check-out</div><div class="checkout-time">demain matin</div><div class="checkout-label">Le ${dateStr}</div></div>
<div class="intro" style="margin-bottom:0">Un avis en ligne nous aiderait énormément. Merci et à bientôt 🌟</div>
</div>
<div class="footer"><div class="footer-thanks">Merci pour votre confiance.</div><div class="footer-sub">${hotelNom} — Ce message est automatique.</div></div>
</div></body></html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${hotelNom} <onboarding@resend.dev>`, to: [stay.email], subject: `Votre check-out demain — ${hotelNom}`, html }),
  });
}

// ═════════════════════════════════════════════
// EMAILS TICKETS
// ═════════════════════════════════════════════

function emailBase(hotelNom, headerColor, headerIcon, headerTitle) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px 12px}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}
.cover{background:${headerColor};padding:28px 24px 22px;text-align:center}.cover-ico{font-size:36px;margin-bottom:8px}
.cover-hotel{color:#fff;font-size:20px;font-weight:700}.cover-sub{color:rgba(255,255,255,.65);font-size:13px;margin-top:4px}
.body{padding:24px}.greeting{font-size:16px;font-weight:600;margin-bottom:12px}
.intro{font-size:14px;color:#444;line-height:1.6;margin-bottom:18px}
.ticket-box{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:18px;text-align:center}
.ticket-label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#64748b;font-weight:600;margin-bottom:4px}
.ticket-id{font-size:28px;font-weight:800;font-family:monospace;color:#1e293b;letter-spacing:2px}
.ticket-subject{font-size:13px;color:#64748b;margin-top:4px}
.msg-box{background:#f1f5f9;border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:14px;color:#334155;line-height:1.6;white-space:pre-wrap}
.cta{display:block;background:${headerColor};color:#fff;text-decoration:none;text-align:center;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:18px}
.footer{border-top:1px solid #f1f5f9;padding:16px 24px;text-align:center}.footer-thanks{font-size:13px;color:#64748b}</style></head><body>
<div class="card"><div class="cover"><div class="cover-ico">${headerIcon}</div><div class="cover-hotel">${hotelNom}</div><div class="cover-sub">${headerTitle}</div></div><div class="body">`;
}

function emailFooter(hotelNom) {
  return `</div><div class="footer"><div class="footer-thanks">Merci de votre confiance — ${hotelNom}</div></div></div></body></html>`;
}

async function resendEmail(env, to, subject, html, from) {
  if (!env.RESEND_API_KEY) return { error: 'RESEND_API_KEY manquante' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { status: r.status };
  } catch (e) { return { error: String(e) }; }
}

async function sendTicketConfirmationToGuest(env, ticket, hotelNom, slug) {
  const ticketUrl = `https://livret-accueil-2wc.pages.dev/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '🎫', 'Votre signalement a bien été reçu')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro">Nous avons bien reçu votre signalement. Notre équipe va le traiter dans les meilleurs délais.</div>`
    + `<div class="ticket-box"><div class="ticket-label">Numéro de ticket</div><div class="ticket-id">#${ticket.id}</div><div class="ticket-subject">${ticket.subject}</div></div>`
    + `<a class="cta" href="${ticketUrl}">Suivre mon ticket →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, ticket.guestEmail, `Ticket #${ticket.id} créé — ${ticket.subject}`, html, `${hotelNom} <onboarding@resend.dev>`);
}

async function sendTicketNotificationToHotel(env, ticket, hotelNom, hotelEmail, newMessage, slug) {
  const adminUrl = `https://livret-accueil-2wc.pages.dev/${slug}/gestion`;
  const html = emailBase(hotelNom, '#dc2626', '⚠️', 'Nouveau signalement reçu')
    + `<div class="greeting">Nouveau message sur le ticket #${ticket.id}</div>`
    + `<div class="intro"><strong>De :</strong> ${ticket.guestName}${ticket.guestPhone ? ' · ' + ticket.guestPhone : ''}<br><strong>Objet :</strong> ${ticket.subject}</div>`
    + `<div class="msg-box">${newMessage}</div>`
    + `<a class="cta" href="${adminUrl}">Répondre depuis la gestion →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, hotelEmail, `⚠️ Ticket #${ticket.id} — ${ticket.subject}`, html, `Livret Digital <onboarding@resend.dev>`);
}

async function sendWelcomeEmail(env, hotel, origin) {
  const adminUrl  = `${origin}/${hotel.slug}/admin`;
  const livretUrl = `${origin}/${hotel.slug}`;
  const html = emailBase('Livret Digital', '#0f766e', '🏨', 'Bienvenue sur Livret Digital !')
    + `<div class="greeting">Bonjour ${hotel.nom},</div>`
    + `<div class="intro">Votre livret d'accueil numérique est prêt. Vos vacanciers peuvent dès maintenant y accéder depuis leur smartphone.</div>`
    + `<div class="ticket-box"><div class="ticket-label">Votre identifiant de connexion</div><div class="ticket-id" style="font-size:16px;letter-spacing:0">${hotel.email}</div><div class="ticket-subject">Utilisez ce mail + votre mot de passe pour accéder à l'espace admin</div></div>`
    + `<a class="cta" href="${adminUrl}">Configurer mon livret →</a>`
    + `<div class="intro" style="text-align:center;font-size:13px;color:#64748b">Lien à partager avec vos vacanciers :<br><a href="${livretUrl}" style="color:#0f766e;font-weight:600">${livretUrl}</a></div>`
    + emailFooter('Livret Digital');
  return resendEmail(env, hotel.email, "🏨 Votre livret d'accueil est prêt !", html, 'Livret Digital <onboarding@resend.dev>');
}

async function sendPasswordResetEmail(env, user, resetUrl) {
  const html = emailBase('Livret Digital', '#7c3aed', '🔑', 'Réinitialisation de mot de passe')
    + `<div class="greeting">Bonjour ${user.nom},</div>`
    + `<div class="intro">Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</div>`
    + `<a class="cta" href="${resetUrl}">Réinitialiser mon mot de passe →</a>`
    + `<div class="intro" style="text-align:center;font-size:12px;color:#94a3b8">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</div>`
    + emailFooter('Livret Digital');
  return resendEmail(env, user.email, '🔑 Réinitialisation de votre mot de passe — Livret Digital', html, 'Livret Digital <onboarding@resend.dev>');
}

async function sendTicketReplyToGuest(env, ticket, hotelNom, replyText, slug) {
  const ticketUrl = `https://livret-accueil-2wc.pages.dev/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '💬', 'Réponse à votre signalement')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro"><strong>${hotelNom}</strong> a répondu à votre ticket <strong>#${ticket.id}</strong> :</div>`
    + `<div class="msg-box">${replyText}</div>`
    + `<a class="cta" href="${ticketUrl}">Voir la conversation →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, ticket.guestEmail, `Réponse à votre ticket #${ticket.id} — ${hotelNom}`, html, `${hotelNom} <onboarding@resend.dev>`);
}

// ═════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════

async function fetchAsset(env, urlString) {
  try { return await env.ASSETS.fetch(new Request(urlString)); }
  catch (_) { return new Response('Not found', { status: 404 }); }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toSlug(nom) {
  return nom.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
}

function enc(s) { return new TextEncoder().encode(s); }
function hex(buf) { return [...buf].map(b => b.toString(16).padStart(2,'0')).join(''); }
function unhex(s) { return Uint8Array.from(s.match(/.{2}/g), b => parseInt(b, 16)); }

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
