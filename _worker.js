/**
 * Cloudflare Pages — _worker.js
 * Architecture multi-hôtel
 *
 * Bindings requis :
 *   CONFIG_KV  → KV namespace (config.js par hôtel + séjours en cours)
 *   DB         → D1 database (hôtels, utilisateurs, tickets, messages)
 *   BREVO_API_KEY  → secret Brevo (envoi emails transactionnels)
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
      const hotels = await env.DB.prepare(
        `SELECT h.slug, h.nom, h.ville, h.created_at, h.plan, h.subscription_status,
                h.subscription_ends_at, h.billing_period, h.chambres, u.email
         FROM hotels h
         LEFT JOIN users u ON u.hotel_slug = h.slug AND u.role = 'hotelier'
         ORDER BY h.created_at DESC`
      ).all();
      return json({ ok: true, hotels: hotels.results });
    }
    if (path.startsWith('/superadmin/hotel/') && path.endsWith('/subscription') && request.method === 'POST') {
      const secret = request.headers.get('X-Auth-Secret') || '';
      if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET)
        return json({ ok: false, error: 'Non autorisé' }, 401);
      const slugTarget = path.split('/')[3];
      return handleAdminSetSubscription(request, env, slugTarget);
    }
    if (path === '/superadmin/migrate-subscription' && request.method === 'POST') {
      const secret = request.headers.get('X-Auth-Secret') || '';
      if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET)
        return json({ ok: false, error: 'Non autorisé' }, 401);
      return handleMigrateSubscription(env);
    }
    if (path === '/superadmin/migrate-to-d1' && request.method === 'POST') {
      return handleMigrateToD1(request, env);
    }

    // ── /register ──
    if (path === '/register' || path === '/register/') {
      if (request.method === 'POST') return handleRegister(request, env, url);
      return fetchAsset(env, url.origin + '/register.html');
    }

    // ── Racine → landing page ──
    if (path === '/' || path === '') {
      return fetchAsset(env, url.origin + '/landing.html');
    }

    // ── Extraire le slug ──
    const parts = path.split('/').filter(Boolean);
    const slug  = parts[0];
    const sub   = parts[1] || '';

    if (slug.includes('.') && !sub) return fetchAsset(env, request.url);

    // ── /{slug}/config.js ──
    if (sub === 'config.js') return handleConfig(request, env, slug);

    // ── /{slug}/subscription ──
    if (sub === 'subscription' && request.method === 'GET')
      return handleGetSubscription(request, env, slug);

    // ── /{slug}/manifest.json ──
    if (sub === 'manifest.json') return handleManifest(env, slug, url);

    // ── /{slug}/admin ──
    if (sub === 'admin' || sub === 'admin.html') {
      return fetchAsset(env, url.origin + '/admin.html');
    }

    // ── /{slug}/planning ──
    if (sub === 'planning' || sub === 'planning.html') {
      return fetchAsset(env, url.origin + '/planning.html');
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

    // ── /{slug}/upload-cover ──
    if (sub === 'upload-cover' && request.method === 'POST') {
      return handleUploadCover(request, env, slug);
    }

    // ── /{slug}/cover-photo ──
    if (sub === 'cover-photo' && request.method === 'GET') {
      return handleGetCoverPhoto(env, slug);
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

    // ── /{slug}/auth/verify-email ──
    if (sub === 'auth' && parts[2] === 'verify-email' && request.method === 'GET') {
      return handleVerifyEmail(request, env, slug, url);
    }

    // ── /{slug}/auth/resend-verification ──
    if (sub === 'auth' && parts[2] === 'resend-verification' && request.method === 'POST') {
      return handleResendVerification(request, env, slug, url);
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

    // ── /{slug}/send-guest-link ──
    if (sub === 'send-guest-link' && request.method === 'POST') {
      return handleSendGuestLink(request, env, slug, url);
    }

    // ── /{slug}/guest-stay (legacy KV — conservé pour compat) ──
    if (sub === 'guest-stay' && request.method === 'GET') {
      return handleGetGuestStay(request, env, slug);
    }
    if (sub === 'guest-stay' && request.method === 'POST') {
      return handleSaveGuestStay(request, env, slug);
    }

    // ── /{slug}/stays — multi-séjours D1 ──
    if (sub === 'stays') {
      if (request.method === 'GET')    return handleListStays(request, env, slug);
      if (request.method === 'POST')   return handleCreateStay(request, env, slug);
      if (request.method === 'DELETE' && parts[2]) return handleDeleteStay(request, env, slug, parts[2]);
    }

    // ── /{slug}/paiement ──
    if (sub === 'paiement' || sub === 'paiement.html') {
      return fetchAsset(env, url.origin + '/paiement.html');
    }

    // ── /{slug}/pay/create ──
    if (sub === 'pay' && parts[2] === 'create' && request.method === 'POST') {
      return handlePayCreate(request, env, slug, url);
    }

    // ── /{slug}/pay/callback ──
    if (sub === 'pay' && parts[2] === 'callback' && request.method === 'POST') {
      return handlePayCallback(request, env, slug);
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

    // ── /{slug} ou /{slug}/ — injection OG tags ──
    if (parts.length <= 2) return serveLivretWithOG(env, slug, url);

    return fetchAsset(env, request.url);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      runCheckoutReminders(env),
      runTrialReminders(env),
    ]));
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
// RATE LIMITING — anti brute-force login
// 5 tentatives max par IP et par email sur 15 min
// ═════════════════════════════════════════════

const RL_WINDOW = 900;  // 15 minutes
const RL_MAX    = 5;    // tentatives avant blocage

async function rlCheck(env, key) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const raw = await env.CONFIG_KV.get(key, 'json');
    if (!raw || now > raw.reset) return { blocked: false, count: 0 };
    return { blocked: raw.count >= RL_MAX, count: raw.count, reset: raw.reset };
  } catch { return { blocked: false, count: 0 }; }
}

async function rlIncrement(env, key) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const raw = await env.CONFIG_KV.get(key, 'json');
    const entry = (!raw || now > raw.reset)
      ? { count: 1, reset: now + RL_WINDOW }
      : { count: raw.count + 1, reset: raw.reset };
    await env.CONFIG_KV.put(key, JSON.stringify(entry), { expirationTtl: RL_WINDOW });
  } catch {}
}

async function rlReset(env, key) {
  try { await env.CONFIG_KV.delete(key); } catch {}
}

// ═════════════════════════════════════════════
// AUTH — LOGIN
// ═════════════════════════════════════════════

async function handleLogin(request, env, slug) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) return json({ ok: false, error: 'Email et mot de passe requis' }, 400);

    const ip       = request.headers.get('CF-Connecting-IP') || 'unknown';
    const emailKey = `rl:login:email:${email.toLowerCase().trim()}`;
    const ipKey    = `rl:login:ip:${ip}`;

    // Vérifier rate limit (IP + email en parallèle)
    const [ipCheck, emailCheck] = await Promise.all([rlCheck(env, ipKey), rlCheck(env, emailKey)]);
    if (ipCheck.blocked || emailCheck.blocked) {
      const resetTs = Math.max(ipCheck.reset || 0, emailCheck.reset || 0);
      const waitMin = Math.max(1, Math.ceil((resetTs - Math.floor(Date.now() / 1000)) / 60));
      return json({ ok: false, error: `Trop de tentatives. Réessayez dans ${waitMin} minute(s).`, code: 'RATE_LIMITED' }, 429);
    }

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE hotel_slug = ? AND email = ? AND active = 1'
    ).bind(slug, email.toLowerCase().trim()).first();

    if (!user || !(await verifyPassword(password, user.password_hash))) {
      // Incrémenter les compteurs sur échec
      await Promise.all([rlIncrement(env, ipKey), rlIncrement(env, emailKey)]);
      return json({ ok: false, error: 'Email ou mot de passe incorrect' }, 401);
    }

    // Bloquer si email non vérifié
    if (user.email_verified === 0) {
      return json({ ok: false, error: 'Votre adresse email n\'est pas encore vérifiée. Consultez votre boîte mail.', code: 'EMAIL_NOT_VERIFIED', slug }, 403);
    }

    // Succès — réinitialiser les compteurs
    await Promise.all([rlReset(env, ipKey), rlReset(env, emailKey)]);

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
    if (env.BREVO_API_KEY) {
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
    const {
      nom, email, password, ville, pays, adresse, telephone, whatsapp,
      hote_nom, wifi_reseau, wifi_mdp, bienvenue_fr, checkin, checkout, chambres,
    } = data;

    // Déterminer le plan selon la taille de l'établissement
    const plan = chambres === '21+' ? 'premium'
               : chambres === '11-20' ? 'pro'
               : chambres === '4-10'  ? 'essentiel'
               : 'starter';
    const trialEndsAt = new Date(Date.now() + 15 * 86400000).toISOString();

    if (!nom || !email || !password)
      return json({ ok: false, error: 'Champs obligatoires manquants (nom, email, password).' }, 400);

    const slug = toSlug(nom);

    // Vérifier doublon slug
    const existing = await env.DB.prepare('SELECT slug FROM hotels WHERE slug = ?').bind(slug).first();
    if (existing)
      return json({ ok: false, error: `Un établissement "${nom}" existe déjà.` }, 409);

    // 1 essai gratuit par adresse email
    const emailLower = email.toLowerCase().trim();
    const emailUsed  = await env.DB.prepare(
      'SELECT u.hotel_slug FROM users u WHERE u.email = ? AND u.role = \'hotelier\' LIMIT 1'
    ).bind(emailLower).first();
    if (emailUsed)
      return json({
        ok:    false,
        error: 'Cette adresse email est déjà associée à un espace Welkomeo. Connectez-vous à votre espace existant.',
        code:  'TRIAL_ALREADY_USED',
        slug:  emailUsed.hotel_slug,
      }, 409);

    const now               = new Date().toISOString();
    const passwordHash      = await hashPassword(password);
    const userId            = crypto.randomUUID();
    const verificationToken = crypto.randomUUID();

    // Créer l'hôtel avec abonnement trial
    await env.DB.prepare(
      `INSERT INTO hotels (slug, nom, ville, pays, adresse, telephone, whatsapp, created_at,
        plan, subscription_status, subscription_ends_at, chambres)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(slug, nom, ville||'', pays||'', adresse||'', telephone||'', whatsapp||'', now,
           plan, 'trial', trialEndsAt, chambres||'1-5').run();

    // Créer l'utilisateur hôtelier (email non vérifié)
    await env.DB.prepare(
      'INSERT INTO users (id, hotel_slug, nom, email, password_hash, role, active, created_at, email_verified, verification_token) VALUES (?,?,?,?,?,?,1,?,0,?)'
    ).bind(userId, slug, nom, email.toLowerCase().trim(), passwordHash, 'hotelier', now, verificationToken).run();

    // Config initiale dans KV — inclut toutes les données saisies à l'inscription
    await env.CONFIG_KV.put(
      'hotel:' + slug + ':config',
      buildInitialConfig({ nom, ville, pays, adresse, telephone, whatsapp, email, hote_nom, wifi_reseau, wifi_mdp, bienvenue_fr, checkin, checkout })
    );

    // Email de vérification (awaité — CF Workers tue les Promises non-awaitées)
    const verifyUrl = `${url.origin}/${slug}/auth/verify-email?token=${verificationToken}`;
    if (env.BREVO_API_KEY) {
      try {
        await sendVerificationEmail(env, { nom, email: email.toLowerCase().trim(), slug }, verifyUrl);
      } catch(e) {
        console.error('[Welkomeo] sendVerificationEmail failed:', String(e));
      }
    } else {
      console.warn('[Welkomeo] BREVO_API_KEY absent — email de vérification non envoyé pour', slug);
    }

    return json({ ok: true, slug, livretUrl: url.origin + '/' + slug, pendingVerification: true });
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

    // Vérifier l'abonnement (sauf superadmin)
    if (auth.payload.role !== 'superadmin') {
      const hotel = await env.DB.prepare(
        'SELECT subscription_status, subscription_ends_at FROM hotels WHERE slug = ?'
      ).bind(slug).first();
      if (hotel) {
        const { status } = computeSubscriptionStatus(hotel);
        if (status === 'expired')
          return json({ ok: false, error: 'Abonnement expiré. Renouvelez pour sauvegarder.', code: 'SUBSCRIPTION_EXPIRED' }, 402);
      }
    }

    const body = await request.text();
    if (!body || !body.includes('const CONFIG'))
      return json({ ok: false, error: 'Contenu invalide' }, 400);

    await env.CONFIG_KV.put('hotel:' + slug + ':config', body);
    return json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ═════════════════════════════════════════════
// UPLOAD / GET COVER PHOTO
// ═════════════════════════════════════════════


// ═════════════════════════════════════════════
// PAYDUNYA — PAIEMENT ABONNEMENT
// ═════════════════════════════════════════════

const PAYDUNYA_PLANS = {
  starter_monthly:   { amount: 4500,   label: 'Welkomeo Starter — Mensuel',   plan: 'starter',   period: 'monthly',  months: 1  },
  starter_annual:    { amount: 45000,  label: 'Welkomeo Starter — Annuel',    plan: 'starter',   period: 'annual',   months: 12 },
  essentiel_monthly: { amount: 7500,   label: 'Welkomeo Essentiel — Mensuel', plan: 'essentiel', period: 'monthly',  months: 1  },
  essentiel_annual:  { amount: 75000,  label: 'Welkomeo Essentiel — Annuel',  plan: 'essentiel', period: 'annual',   months: 12 },
  pro_monthly:       { amount: 11000,  label: 'Welkomeo Pro — Mensuel',       plan: 'pro',       period: 'monthly',  months: 1  },
  pro_annual:        { amount: 110000, label: 'Welkomeo Pro — Annuel',        plan: 'pro',       period: 'annual',   months: 12 },
  premium_monthly:   { amount: 16500,  label: 'Welkomeo Premium — Mensuel',   plan: 'premium',   period: 'monthly',  months: 1  },
  premium_annual:    { amount: 165000, label: 'Welkomeo Premium — Annuel',    plan: 'premium',   period: 'annual',   months: 12 },
};

async function handlePayCreate(request, env, slug, url) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;

  // Vérifier les clés PayDunya
  const masterKey  = env.PAYDUNYA_MASTER_KEY;
  const privateKey = env.PAYDUNYA_PRIVATE_KEY;
  const token      = env.PAYDUNYA_TOKEN;
  if (!masterKey || !privateKey || !token) {
    return json({ ok: false, error: 'Configuration PayDunya manquante. Vérifiez les secrets Cloudflare.' }, 500);
  }

  let body;
  try { body = await request.json(); } catch(e) { return json({ ok: false, error: 'JSON invalide' }, 400); }

  const { plan, period } = body || {};
  const planKey = (plan || '') + '_' + (period || '');
  const planInfo = PAYDUNYA_PLANS[planKey];
  if (!planInfo) return json({ ok: false, error: 'Plan invalide : ' + planKey }, 400);

  // Récupérer les infos de l'hôtel
  const hotel = await env.DB.prepare('SELECT nom, email FROM hotels WHERE slug = ?').bind(slug).first();
  if (!hotel) return json({ ok: false, error: 'Hôtel non trouvé' }, 404);

  const origin    = url.origin;
  const returnUrl = origin + '/' + slug + '/admin?payment=success';
  const cancelUrl = origin + '/' + slug + '/paiement?cancelled=1';
  const callbackUrl = origin + '/' + slug + '/pay/callback';

  // Stocker un token de session pour valider le callback
  const invoiceToken = crypto.randomUUID();
  await env.CONFIG_KV.put(
    'pay:pending:' + slug + ':' + invoiceToken,
    JSON.stringify({ plan: planInfo.plan, period: planInfo.period, months: planInfo.months, slug }),
    { expirationTtl: 3600 }
  );

  const payload = {
    invoice: {
      total_amount: planInfo.amount,
      description: planInfo.label + ' — ' + hotel.nom,
    },
    store: {
      name: 'Welkomeo',
      tagline: 'Livret d\'accueil numérique',
      website_url: 'https://welkomeo.com',
    },
    actions: {
      cancel_url: cancelUrl,
      return_url: returnUrl,
      callback_url: callbackUrl,
    },
    custom_data: {
      slug: slug,
      plan: planInfo.plan,
      period: planInfo.period,
      months: planInfo.months,
      token: invoiceToken,
    },
  };

  let pdResp, pdData;
  try {
    pdResp = await fetch('https://app.paydunya.com/api/v1/checkout-invoice/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYDUNYA-MASTER-KEY':  masterKey,
        'PAYDUNYA-PRIVATE-KEY': privateKey,
        'PAYDUNYA-TOKEN':       token,
      },
      body: JSON.stringify(payload),
    });
    pdData = await pdResp.json();
  } catch(e) {
    console.error('[PayDunya] fetch error', String(e));
    return json({ ok: false, error: 'Erreur de connexion PayDunya' }, 502);
  }

  if (!pdResp.ok || pdData.response_code !== '00') {
    console.error('[PayDunya] create invoice error', pdResp.status, JSON.stringify(pdData));
    return json({ ok: false, error: pdData.response_text || 'Erreur PayDunya' }, 502);
  }

  return json({ ok: true, redirect_url: pdData.response_text });
}

async function handlePayCallback(request, env, slug) {
  // PayDunya envoie une notification IPN en POST
  let body;
  try { body = await request.json(); } catch(e) { return new Response('ok', { status: 200 }); }

  const invoiceData = body.data || body;
  const status = (invoiceData.status || '').toLowerCase();

  // Accepter seulement les paiements confirmés
  if (status !== 'completed' && status !== 'done') {
    return new Response('ok', { status: 200 });
  }

  // Récupérer les custom_data
  const custom = invoiceData.custom_data || {};
  const pendingSlug = custom.slug || slug;
  const plan   = custom.plan;
  const period = custom.period;
  const months = parseInt(custom.months || '1', 10);
  const invoiceToken = custom.token;

  if (!plan || !pendingSlug) return new Response('ok', { status: 200 });

  // Valider via le token stocké en KV (anti-replay)
  if (invoiceToken) {
    const stored = await env.CONFIG_KV.get('pay:pending:' + pendingSlug + ':' + invoiceToken);
    if (!stored) {
      console.warn('[PayDunya] token IPN inconnu ou expiré :', invoiceToken);
      return new Response('ok', { status: 200 });
    }
    await env.CONFIG_KV.delete('pay:pending:' + pendingSlug + ':' + invoiceToken);
  }

  // Calculer la nouvelle date d'expiration
  const now = new Date();
  // Si abonnement actif, prolonger depuis la date d'expiration actuelle
  const current = await env.DB.prepare(
    'SELECT subscription_status, subscription_ends_at FROM hotels WHERE slug = ?'
  ).bind(pendingSlug).first();

  let base = now;
  if (current && current.subscription_ends_at) {
    const ends = new Date(current.subscription_ends_at);
    if (ends > now) base = ends;
  }

  const newEnds = new Date(base);
  newEnds.setMonth(newEnds.getMonth() + months);

  await env.DB.prepare(
    'UPDATE hotels SET subscription_status = ?, subscription_plan = ?, subscription_ends_at = ? WHERE slug = ?'
  ).bind('active', plan, newEnds.toISOString(), pendingSlug).run();

  console.log('[PayDunya] abonnement activé :', pendingSlug, plan, period, '->', newEnds.toISOString());

  // Notifier l'hôtelier par email
  try {
    const hotel = await env.DB.prepare('SELECT nom, email FROM hotels WHERE slug = ?').bind(pendingSlug).first();
    if (hotel && hotel.email) {
      const planLabel = { starter:'Starter', essentiel:'Essentiel', pro:'Pro', premium:'Premium' }[plan] || plan;
      const periodLabel = period === 'annual' ? 'Annuel' : 'Mensuel';
      const dateStr = newEnds.toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' });
      await resendEmail(env, hotel.email, '✅ Votre abonnement Welkomeo est actif',
        `<p>Bonjour,</p>
        <p>Votre abonnement <strong>Welkomeo ${planLabel} ${periodLabel}</strong> a été activé avec succès.</p>
        <p>Valide jusqu'au : <strong>${dateStr}</strong></p>
        <p>Vous pouvez gérer votre livret sur <a href="https://welkomeo.com/${pendingSlug}/admin">welkomeo.com/${pendingSlug}/admin</a></p>
        <p>Merci de votre confiance,<br>L'équipe Welkomeo</p>`
      );
    }
  } catch(e) {
    console.error('[PayDunya] email notification error', String(e));
  }

  return new Response('ok', { status: 200 });
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
    if (guestEmail && env.BREVO_API_KEY) {
      const r = await sendTicketConfirmationToGuest(env, ticketForEmail, hotelNom, slug);
      emailSent = r && r.status === 200;
    }
    if (hotelEmail && env.BREVO_API_KEY) {
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
    if (env.BREVO_API_KEY) {
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
// SÉJOURS MULTI-VOYAGEURS (D1)
// ═════════════════════════════════════════════

function stayAuth(request, env, slug) {
  return getToken(request)
    ? verifyJWT(getToken(request), env).then(p =>
        p && p.slug === slug && (p.role === 'hotelier' || p.role === 'gestionnaire') ? p : null)
    : Promise.resolve(null);
}

async function handleListStays(request, env, slug) {
  const p = await stayAuth(request, env, slug);
  if (!p) return json({ ok: false, error: 'Non autorisé' }, 401);
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await env.DB.prepare(
      'SELECT * FROM stays WHERE hotel_slug = ? AND checkout >= ? ORDER BY checkout ASC, room ASC'
    ).bind(slug, today).all();
    return json({ ok: true, stays: rows.results });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function handleCreateStay(request, env, slug) {
  const p = await stayAuth(request, env, slug);
  if (!p) return json({ ok: false, error: 'Non autorisé' }, 401);
  try {
    const { guestName, guestEmail, guestPhone, room, checkin, checkout, civility } = await request.json();
    if (!guestName || !checkin || !checkout) return json({ ok: false, error: 'Nom, arrivée et départ requis' }, 400);
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO stays (id, hotel_slug, guest_name, guest_email, guest_phone, room, checkin, checkout, created_at, civility) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(id, slug, guestName, guestEmail||'', guestPhone||'', room||'', checkin, checkout, now, civility||'').run();
    return json({ ok: true, id });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function handleDeleteStay(request, env, slug, stayId) {
  const p = await stayAuth(request, env, slug);
  if (!p) return json({ ok: false, error: 'Non autorisé' }, 401);
  try {
    await env.DB.prepare('DELETE FROM stays WHERE id = ? AND hotel_slug = ?').bind(stayId, slug).run();
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ═════════════════════════════════════════════
// PHOTO DE COUVERTURE (KV)
// ═════════════════════════════════════════════

async function handleUploadCover(request, env, slug) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;
  try {
    const { base64, filename } = await request.json();
    if (!base64 || !base64.startsWith('data:image/')) {
      return json({ ok: false, error: 'Format invalide. Envoyez un data URL image.' }, 400);
    }
    // Vérifier taille approximative (~3MB en base64 ≈ 4MB)
    if (base64.length > 4.5 * 1024 * 1024) {
      return json({ ok: false, error: 'Image trop lourde (max 3 Mo).' }, 400);
    }
    const kvKey = `hotel:${slug}:cover_photo`;
    await env.CONFIG_KV.put(kvKey, base64);
    const photoUrl = `/${slug}/cover-photo`;
    return json({ ok: true, url: photoUrl });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetCoverPhoto(env, slug) {
  try {
    const data = await env.CONFIG_KV.get(`hotel:${slug}:cover_photo`);
    if (!data) return new Response('Not found', { status: 404 });
    // Extraire le mime type du data URL (ex: data:image/jpeg;base64,...)
    const mime = data.match(/^data:([^;]+);base64,/)?.[1] || 'image/jpeg';
    const b64  = data.replace(/^data:[^;]+;base64,/, '');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(bytes, {
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
      }
    });
  } catch (e) {
    return new Response('Error', { status: 500 });
  }
}

// ═════════════════════════════════════════════
// SÉJOUR EN COURS (KV — inchangé)
// ═════════════════════════════════════════════

// ═════════════════════════════════════════════
// ENVOI LIEN LIVRET AU VOYAGEUR (email HTML premium)
// ═════════════════════════════════════════════

async function handleSendGuestLink(request, env, slug, url) {
  const token   = getToken(request);
  const payload = await verifyJWT(token, env);
  const isAuth  = payload && (payload.slug === slug) && (payload.role === 'hotelier' || payload.role === 'gestionnaire');
  if (!isAuth) return json({ ok: false, error: 'Non autorisé' }, 401);

  try {
    const { guestName, guestEmail, room, livretUrl, coverPhoto, hotelNom, hotelVille } = await request.json();
    if (!guestEmail) return json({ ok: false, error: 'Email requis' }, 400);
    if (!env.BREVO_API_KEY) return json({ ok: false, error: 'Email non configuré' }, 500);

    // Rendre la photo absolue si relative
    const origin = url.origin;
    const photoUrl = coverPhoto
      ? (coverPhoto.startsWith('http') ? coverPhoto : origin + coverPhoto)
      : null;

    const html = buildGuestLivretEmail({ guestName, room, livretUrl, coverPhoto: photoUrl, hotelNom, hotelVille });
    const from  = `${hotelNom || 'Welkomeo'} <noreply@welkomeo.com>`;
    const r = await resendEmail(env, guestEmail, `Votre livret d'accueil — ${hotelNom}`, html, from);

    if (r && (r.status === 200 || r.status === 201)) return json({ ok: true });
    const errBody = r ? await r.text().catch(() => '') : '';
    return json({ ok: false, error: 'Erreur Brevo: ' + errBody }, 500);
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

function buildGuestLivretEmail({ guestName, room, livretUrl, coverPhoto, hotelNom, hotelVille }) {
  const prenom   = guestName ? guestName.split(' ')[0] : '';
  const roomLine = room ? `en <strong>chambre ${room}</strong>` : '';
  const loc      = hotelVille ? `<div style="color:rgba(255,255,255,0.55);font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-top:8px">${hotelVille}</div>` : '';

  const header = coverPhoto
    ? `<div style="position:relative;min-height:210px;background:url(${coverPhoto}) center/cover no-repeat">
         <div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(5,20,50,0.45) 0%,rgba(5,20,50,0.65) 100%)"></div>
         <div style="position:relative;padding:44px 24px 36px;text-align:center">
           <div style="color:#c9a84c;font-size:9px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px;font-weight:600">Livret d'accueil</div>
           <div style="color:#fff;font-size:26px;letter-spacing:4px;text-transform:uppercase;font-family:Georgia,'Times New Roman',serif;font-weight:400">${hotelNom}</div>
           ${loc}
           <div style="width:32px;height:1px;background:#c9a84c;margin:16px auto 0;opacity:0.7"></div>
         </div>
       </div>`
    : `<div style="background:#053372;padding:40px 24px 32px;text-align:center">
         <div style="color:#c9a84c;font-size:9px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px;font-weight:600">Livret d'accueil</div>
         <div style="color:#fff;font-size:24px;letter-spacing:4px;text-transform:uppercase;font-family:Georgia,'Times New Roman',serif;font-weight:400">${hotelNom}</div>
         ${loc}
         <div style="width:32px;height:1px;background:#c9a84c;margin:16px auto 0;opacity:0.7"></div>
       </div>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12)">
  ${header}
  <div style="padding:28px 24px 20px">
    <p style="font-size:16px;font-weight:600;color:#1c1409;margin:0 0 14px">Bonjour${prenom ? ' ' + prenom : ''} 👋</p>
    <p style="font-size:14px;color:#475569;line-height:1.75;margin:0 0 16px">${hotelNom} vous envoie votre livret d'accueil numérique${roomLine ? ' — vous êtes attendu(e) ' + roomLine : ''}.</p>
    <p style="font-size:14px;color:#475569;line-height:1.75;margin:0 0 26px">Retrouvez-y toutes les informations utiles pour votre séjour : WiFi, équipements, bons plans, transports, urgences…</p>
    <a href="${livretUrl}" style="display:block;background:#053372;color:#fff;text-decoration:none;text-align:center;padding:16px 24px;border-radius:10px;font-size:13px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;border-bottom:3px solid #c9a84c">Accéder à mon livret →</a>
    <p style="font-size:11px;color:#94a3b8;text-align:center;margin:0">Ou copiez ce lien : <a href="${livretUrl}" style="color:#053372">${livretUrl}</a></p>
  </div>
  <div style="border-top:1px solid #f1f5f9;padding:14px 24px;text-align:center">
    <p style="font-size:12px;color:#94a3b8;margin:0">À très bientôt — <strong style="color:#1c1409">${hotelNom}</strong></p>
  </div>
</div>
</body></html>`;
}

async function handleGetGuestStay(request, env, slug) {
  const token   = getToken(request);
  const payload = await verifyJWT(token, env);
  const secret  = request.headers.get('X-Auth-Secret') || '';
  const isSuperAdmin = env.AUTH_SECRET && secret === env.AUTH_SECRET;
  const isHotelier   = payload && payload.slug === slug && (payload.role === 'hotelier' || payload.role === 'gestionnaire');
  if (!isSuperAdmin && !isHotelier) return json({ ok: false, error: 'Non autorisé' }, 401);
  try {
    const raw = await env.CONFIG_KV.get(`hotel:${slug}:current_stay`);
    if (!raw) return json({ ok: true, stay: null });
    return json({ ok: true, stay: JSON.parse(raw) });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

async function handleSaveGuestStay(request, env, slug) {
  const secret = request.headers.get('X-Auth-Secret') || '';
  const token  = getToken(request);
  const payload = await verifyJWT(token, env);
  const isSuperAdmin = env.AUTH_SECRET && secret === env.AUTH_SECRET;
  const isHotelier   = payload && payload.slug === slug && payload.role === 'hotelier';
  if (!isSuperAdmin && !isHotelier)
    return json({ ok: false, error: 'Non autorisé' }, 401);

  try {
    const { nom, email, checkout, room } = await request.json();
    if (!email || !checkout) return json({ ok: false, error: 'Email et date de checkout requis' }, 400);
    await env.CONFIG_KV.put(
      `hotel:${slug}:current_stay`,
      JSON.stringify({ nom: nom||'', email, checkout, room: room||'', saved: new Date().toISOString() })
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
  if (!env.BREVO_API_KEY) return;
  const tomorrow    = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  try {
    const hotels = await env.DB.prepare('SELECT slug, nom FROM hotels').all();
    for (const h of hotels.results) {
      // ── Legacy KV (séjour unique) ──
      try {
        const stayRaw = await env.CONFIG_KV.get(`hotel:${h.slug}:current_stay`);
        if (stayRaw) {
          const stay = JSON.parse(stayRaw);
          if (stay.checkout === tomorrowStr && stay.email) {
            await sendCheckoutReminder(env, { nom: stay.nom, email: stay.email, checkout: stay.checkout }, h.nom, h.slug);
            await env.CONFIG_KV.delete(`hotel:${h.slug}:current_stay`);
          }
        }
      } catch (_) {}

      // ── D1 stays (multi-voyageurs) ──
      try {
        const rows = await env.DB.prepare(
          'SELECT * FROM stays WHERE hotel_slug = ? AND checkout = ? AND guest_email != ?'
        ).bind(h.slug, tomorrowStr, '').all();
        for (const stay of rows.results) {
          try {
            await sendCheckoutReminder(env, { nom: stay.guest_name, email: stay.guest_email, checkout: stay.checkout }, h.nom, h.slug);
          } catch (_) {}
        }
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

  await resendEmail(env, stay.email, `Votre check-out demain — ${hotelNom}`, html, `Welkomeo <noreply@welkomeo.com>`);
}

// ═════════════════════════════════════════════
// RAPPELS FIN DE TRIAL
// ═════════════════════════════════════════════

async function runTrialReminders(env) {
  if (!env.BREVO_API_KEY) return;

  const now   = new Date();
  const day3  = new Date(now); day3.setDate(day3.getDate() + 3);
  const day1  = new Date(now); day1.setDate(day1.getDate() + 1);

  const d3str = day3.toISOString().slice(0, 10); // J-3 : expiration dans 3 jours
  const d1str = day1.toISOString().slice(0, 10); // J-0 : expiration demain (envoyé aujourd'hui)

  // Récupérer les hôtels trial dont l'expiration tombe dans 3 jours OU demain
  const { results } = await env.DB.prepare(`
    SELECT h.slug, h.nom, h.subscription_ends_at, h.plan,
           u.email, u.nom as responsable
    FROM hotels h
    JOIN users u ON u.hotel_slug = h.slug AND u.role = 'hotelier' AND u.active = 1
    WHERE h.subscription_status = 'trial'
      AND (substr(h.subscription_ends_at, 1, 10) = ? OR substr(h.subscription_ends_at, 1, 10) = ?)
  `).bind(d3str, d1str).all();

  for (const h of results || []) {
    const expiresDate = h.subscription_ends_at ? h.subscription_ends_at.slice(0, 10) : '';
    const isLastDay   = expiresDate === d1str;
    const adminUrl    = `https://welkomeo.com/${h.slug}/admin`;
    const planLabels  = { starter:'Starter (1–3 chambres)', essentiel:'Essentiel (4–10 chambres)', pro:'Pro (11–20 chambres)', premium:'Premium (21+ chambres)' };
    const planLabel   = planLabels[h.plan] || h.plan;

    const subject = isLastDay
      ? `⚠️ Votre essai Welkomeo expire demain`
      : `📅 Plus que 3 jours d'essai gratuit — Welkomeo`;

    const intro = isLastDay
      ? `Votre période d'essai gratuit se termine <strong>demain</strong>. Sans abonnement, vous ne pourrez plus enregistrer vos modifications.`
      : `Il vous reste <strong>3 jours</strong> d'essai gratuit sur Welkomeo. Profitez-en pour configurer votre livret !`;

    const html = emailBase('Welkomeo', '#053372', isLastDay ? '⚠️' : '📅', subject.replace(/^[^ ]+ /, ''))
      + `<div class="greeting">Bonjour ${h.responsable},</div>`
      + `<div class="intro">${intro}</div>`
      + `<div class="intro">Pour continuer à utiliser Welkomeo sans interruption, choisissez votre formule :</div>`
      + `<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">`
      + `<tr style="background:#f1f5f9"><td style="padding:8px 12px;font-weight:700">Starter</td><td style="padding:8px 12px">1–3 chambres</td><td style="padding:8px 12px;font-weight:700;color:#053372">4 500 FCFA/mois</td><td style="padding:8px 12px;color:#15803d">45 000 FCFA/an</td></tr>`
      + `<tr><td style="padding:8px 12px;font-weight:700">Essentiel</td><td style="padding:8px 12px">4–10 chambres</td><td style="padding:8px 12px;font-weight:700;color:#053372">7 500 FCFA/mois</td><td style="padding:8px 12px;color:#15803d">75 000 FCFA/an</td></tr>`
      + `<tr style="background:#f1f5f9"><td style="padding:8px 12px;font-weight:700">Pro</td><td style="padding:8px 12px">11–20 chambres</td><td style="padding:8px 12px;font-weight:700;color:#053372">11 000 FCFA/mois</td><td style="padding:8px 12px;color:#15803d">110 000 FCFA/an</td></tr>`
      + `<tr><td style="padding:8px 12px;font-weight:700">Premium</td><td style="padding:8px 12px">21 chambres et +</td><td style="padding:8px 12px;font-weight:700;color:#053372">16 500 FCFA/mois</td><td style="padding:8px 12px;color:#15803d">165 000 FCFA/an</td></tr>`
      + `</table>`
      + `<a class="cta" href="${adminUrl}">S'abonner depuis mon espace admin →</a>`
      + `<div class="intro" style="text-align:center;font-size:12px;color:#94a3b8">Votre livret : <a href="https://welkomeo.com/${h.slug}" style="color:#053372">welkomeo.com/${h.slug}</a></div>`
      + emailFooter('Welkomeo · par Assenka');

    try {
      await resendEmail(env, h.email, subject, html, 'Welkomeo <noreply@welkomeo.com>');
    } catch(e) {
      console.error('[Welkomeo] runTrialReminders email failed for', h.slug, String(e));
    }
  }
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

function parseEmailFrom(from) {
  const m = (from || '').match(/^(.+?)\s*<([^>]+)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: 'Welkomeo', email: 'noreply@welkomeo.com' };
}

async function resendEmail(env, to, subject, html, from) {
  const apiKey = env.BREVO_API_KEY;
  if (!apiKey) return { error: 'BREVO_API_KEY manquante' };
  try {
    const sender = parseEmailFrom(from);
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error('[Brevo] send error', r.status, body);
    }
    return { status: r.status };
  } catch (e) { return { error: String(e) }; }
}

async function sendTicketConfirmationToGuest(env, ticket, hotelNom, slug) {
  const ticketUrl = `https://welkomeo.com/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '🎫', 'Votre signalement a bien été reçu')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro">Nous avons bien reçu votre signalement. Notre équipe va le traiter dans les meilleurs délais.</div>`
    + `<div class="ticket-box"><div class="ticket-label">Numéro de ticket</div><div class="ticket-id">#${ticket.id}</div><div class="ticket-subject">${ticket.subject}</div></div>`
    + `<a class="cta" href="${ticketUrl}">Suivre mon ticket →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, ticket.guestEmail, `Ticket #${ticket.id} créé — ${ticket.subject}`, html, `${hotelNom} <noreply@welkomeo.com>`);
}

async function sendTicketNotificationToHotel(env, ticket, hotelNom, hotelEmail, newMessage, slug) {
  const adminUrl = `https://welkomeo.com/${slug}/gestion`;
  const html = emailBase(hotelNom, '#dc2626', '⚠️', 'Nouveau signalement reçu')
    + `<div class="greeting">Nouveau message sur le ticket #${ticket.id}</div>`
    + `<div class="intro"><strong>De :</strong> ${ticket.guestName}${ticket.guestPhone ? ' · ' + ticket.guestPhone : ''}<br><strong>Objet :</strong> ${ticket.subject}</div>`
    + `<div class="msg-box">${newMessage}</div>`
    + `<a class="cta" href="${adminUrl}">Répondre depuis la gestion →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, hotelEmail, `⚠️ Ticket #${ticket.id} — ${ticket.subject}`, html, `Welkomeo <noreply@welkomeo.com>`);
}

async function sendWelcomeEmail(env, hotel, origin) {
  const adminUrl  = `${origin}/${hotel.slug}/admin`;
  const livretUrl = `${origin}/${hotel.slug}`;
  const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" width="48" height="48" fill="none" style="display:block;margin:0 auto 10px"><path d="M28 3 L53 28 L28 53 L3 28 Z" stroke="#C9A84C" stroke-width="1.8" fill="none"/><path d="M28 11 L45 28 L28 45 L11 28 Z" fill="#C9A84C" fill-opacity="0.18"/><text x="28" y="34" text-anchor="middle" font-family="Georgia,serif" font-size="20" font-weight="600" fill="#C9A84C">W</text></svg>`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#f0ece6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px 12px}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}
.cover{background:#1a1a1a;padding:28px 24px 22px;text-align:center}
.cover-wordmark{font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:500;letter-spacing:1px;color:#fff;margin-bottom:3px}
.cover-wordmark em{color:#C9A84C;font-style:normal}
.cover-tagline{font-size:8px;letter-spacing:2.5px;color:rgba(201,168,76,.7);text-transform:uppercase;margin-bottom:8px}
.cover-sub{color:rgba(255,255,255,.45);font-size:13px;font-style:italic}
.body{padding:24px}
.greeting{font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:600;color:#1a1a1a;margin-bottom:12px}
.intro{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;color:#555;line-height:1.7;margin-bottom:18px}
.id-box{background:#f8f7f4;border:1px solid #e8e4dc;border-radius:12px;padding:16px 20px;margin-bottom:18px;text-align:center}
.id-label{font-size:10px;text-transform:uppercase;letter-spacing:.9px;color:#bbb;font-weight:600;margin-bottom:5px}
.id-email{font-family:'Cormorant Garamond',Georgia,serif;font-size:16px;font-weight:700;color:#C9A84C;word-break:break-all;margin-bottom:5px}
.id-note{font-family:'Cormorant Garamond',Georgia,serif;font-size:13px;color:#999}
.cta{display:block;background:#1a1a1a;color:#fff;text-decoration:none;text-align:center;padding:14px 24px;border-radius:10px;font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;font-size:16px;letter-spacing:.3px;margin-bottom:18px}
.share-note{font-family:'Cormorant Garamond',Georgia,serif;text-align:center;font-size:14px;color:#999;margin-bottom:4px}
.share-link{color:#C9A84C;font-weight:600;text-decoration:none}
.footer{border-top:1px solid #f0ece4;padding:16px 24px;text-align:center}
.footer-thanks{font-family:'Cormorant Garamond',Georgia,serif;font-size:13px;color:#bbb;font-style:italic}</style></head><body>
<div class="card">
  <div class="cover">
    ${logoSvg}
    <div class="cover-wordmark">Welkom<em>eo</em></div>
    <div class="cover-tagline">Livret d'accueil digital</div>
    <div class="cover-sub">Bienvenue sur Welkomeo !</div>
  </div>
  <div class="body">
    <div class="greeting">Bonjour ${hotel.nom},</div>
    <div class="intro">Votre livret d'accueil numérique est prêt. Vos vacanciers peuvent dès maintenant y accéder depuis leur smartphone.</div>
    <div class="id-box">
      <div class="id-label">Votre identifiant de connexion</div>
      <div class="id-email">${hotel.email}</div>
      <div class="id-note">Utilisez ce mail + votre mot de passe pour accéder à l'espace admin</div>
    </div>
    <a class="cta" href="${adminUrl}">Configurer mon livret →</a>
    <div class="share-note">Lien à partager avec vos vacanciers :<br><a href="${livretUrl}" class="share-link">${livretUrl}</a></div>
  </div>
  <div class="footer"><div class="footer-thanks">Merci de votre confiance — Welkomeo · par Assenka</div></div>
</div></body></html>`;
  const from = env.BREVO_FROM || 'Welkomeo <noreply@welkomeo.com>';
  return resendEmail(env, hotel.email, "Votre Welkomeo est prêt !", html, from);
}

async function handleVerifyEmail(request, env, slug, url) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) {
    return new Response(null, { status: 302, headers: { 'Location': `${url.origin}/register?error=token_manquant` } });
  }

  const user = await env.DB.prepare(
    'SELECT * FROM users WHERE hotel_slug = ? AND verification_token = ?'
  ).bind(slug, token).first();

  if (!user) {
    return new Response(null, { status: 302, headers: { 'Location': `${url.origin}/register?error=lien_invalide` } });
  }

  // Marquer email comme vérifié
  await env.DB.prepare(
    'UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?'
  ).bind(user.id).run();

  // Auto-login : générer un JWT et rediriger vers admin
  const jwtToken = await signJWT({
    sub: user.id, slug, role: user.role, nom: user.nom,
    exp: Math.floor(Date.now()/1000) + 86400*30,
  }, env);

  // Envoyer l'email de bienvenue (awaité — CF Workers tue les Promises non-awaitées)
  if (env.BREVO_API_KEY) {
    try {
      await sendWelcomeEmail(env, { nom: user.nom, email: user.email, slug }, url.origin);
    } catch(e) {
      console.error('[Welkomeo] sendWelcomeEmail failed:', String(e));
    }
  }

  const adminUrl = `${url.origin}/${slug}/admin?verified=1&authtoken=${jwtToken}`;
  return new Response(null, { status: 302, headers: { 'Location': adminUrl } });
}

async function handleResendVerification(request, env, slug, url) {
  try {
    const { email } = await request.json();
    if (!email) return json({ ok: false, error: 'Email requis' }, 400);

    const user = await env.DB.prepare(
      'SELECT id, nom, email, email_verified FROM users WHERE hotel_slug = ? AND email = ? AND active = 1'
    ).bind(slug, email.toLowerCase().trim()).first();

    // Réponse identique qu'il existe ou non (anti-énumération)
    if (!user || user.email_verified === 1) return json({ ok: true });

    const newToken = crypto.randomUUID();
    await env.DB.prepare(
      'UPDATE users SET verification_token = ? WHERE id = ?'
    ).bind(newToken, user.id).run();

    const verifyUrl = `${url.origin}/${slug}/auth/verify-email?token=${newToken}`;
    if (env.BREVO_API_KEY) {
      await sendVerificationEmail(env, { nom: user.nom, email: user.email, slug }, verifyUrl);
    }

    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function sendVerificationEmail(env, hotel, verifyUrl) {
  const html = emailBase('Welkomeo', '#053372', '✉️', 'Vérifiez votre adresse email')
    + `<div class="greeting">Bonjour ${hotel.nom},</div>`
    + `<div class="intro">Merci de votre inscription sur Welkomeo ! Pour activer votre compte et accéder à votre espace admin, veuillez confirmer votre adresse email en cliquant sur le bouton ci-dessous.</div>`
    + `<a class="cta" href="${verifyUrl}">Vérifier mon adresse email →</a>`
    + `<div class="intro" style="text-align:center;font-size:12px;color:#94a3b8">Ce lien est valable <strong>48 heures</strong>. Si vous n'avez pas créé de compte Welkomeo, ignorez cet email.</div>`
    + emailFooter('Welkomeo · par Assenka');
  const from = env.BREVO_FROM || 'Welkomeo <noreply@welkomeo.com>';
  return resendEmail(env, hotel.email, '✉️ Confirmez votre adresse email — Welkomeo', html, from);
}

async function sendPasswordResetEmail(env, user, resetUrl) {
  const html = emailBase('Welkomeo', '#7c3aed', '🔑', 'Réinitialisation de mot de passe')
    + `<div class="greeting">Bonjour ${user.nom},</div>`
    + `<div class="intro">Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</div>`
    + `<a class="cta" href="${resetUrl}">Réinitialiser mon mot de passe →</a>`
    + `<div class="intro" style="text-align:center;font-size:12px;color:#94a3b8">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</div>`
    + emailFooter('Welkomeo · par Assenka');
  return resendEmail(env, user.email, '🔑 Réinitialisation de votre mot de passe — Welkomeo', html, 'Welkomeo <noreply@welkomeo.com>');
}

async function sendTicketReplyToGuest(env, ticket, hotelNom, replyText, slug) {
  const ticketUrl = `https://welkomeo.com/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '💬', 'Réponse à votre signalement')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro"><strong>${hotelNom}</strong> a répondu à votre ticket <strong>#${ticket.id}</strong> :</div>`
    + `<div class="msg-box">${replyText}</div>`
    + `<a class="cta" href="${ticketUrl}">Voir la conversation →</a>`
    + emailFooter(hotelNom);
  return resendEmail(env, ticket.guestEmail, `Réponse à votre ticket #${ticket.id} — ${hotelNom}`, html, `${hotelNom} <noreply@welkomeo.com>`);
}

// ═════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════

async function fetchAsset(env, urlString) {
  try { return await env.ASSETS.fetch(new Request(urlString)); }
  catch (_) { return new Response('Not found', { status: 404 }); }
}

// Sert index.html avec OG meta tags dynamiques (aperçu WhatsApp/iMessage)
async function serveLivretWithOG(env, slug, url) {
  const assetResp = await fetchAsset(env, url.origin + '/index.html');
  if (!assetResp.ok) return assetResp;

  // Infos hôtel depuis D1
  let nom = '', ville = '', pays = '';
  try {
    const hotel = await env.DB.prepare('SELECT nom, ville, pays FROM hotels WHERE slug = ?').bind(slug).first();
    if (hotel) { nom = hotel.nom || ''; ville = hotel.ville || ''; pays = hotel.pays || ''; }
  } catch(_) {}

  const loc    = [ville, pays].filter(Boolean).join(' · ');
  const ogTitle = nom
    ? `${nom} — Votre livret de séjour`
    : 'Welkomeo — Livret de séjour numérique';
  const ogDesc = nom
    ? `${nom}${loc ? ' (' + loc + ')' : ''} vous souhaite la bienvenue et se réjouit de vous recevoir très bientôt. Retrouvez toutes les informations pratiques de votre séjour.`
    : 'Votre livret de séjour numérique — WiFi, services, urgences et bons plans.';
  const ogImage = `${url.origin}/${slug}/cover.jpg`;
  const ogUrl   = `${url.origin}/${slug}`;

  const esc = s => s.replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const ogTags = [
    `<meta property="og:type"        content="website">`,
    `<meta property="og:url"         content="${esc(ogUrl)}">`,
    `<meta property="og:title"       content="${esc(ogTitle)}">`,
    `<meta property="og:description" content="${esc(ogDesc)}">`,
    `<meta property="og:image"       content="${esc(ogImage)}">`,
    `<meta name="twitter:card"        content="summary_large_image">`,
    `<meta name="twitter:title"       content="${esc(ogTitle)}">`,
    `<meta name="twitter:description" content="${esc(ogDesc)}">`,
    `<meta name="twitter:image"       content="${esc(ogImage)}">`,
  ].join('\n  ');

  let html = await assetResp.text();
  html = html.replace('</head>', `  ${ogTags}\n</head>`);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
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

// ═════════════════════════════════════════════
// ABONNEMENTS
// ═════════════════════════════════════════════

// Tarification (FCFA)
const PLANS = {
  small: { monthly: 7500,  annual: 75000  },
  large: { monthly: 15000, annual: 150000 },
};

function computeSubscriptionStatus(hotel) {
  const now    = Date.now();
  const endsAt = hotel.subscription_ends_at ? new Date(hotel.subscription_ends_at).getTime() : null;
  let status   = hotel.subscription_status || 'trial';
  const daysLeft = endsAt ? Math.ceil((endsAt - now) / 86400000) : null;
  if (daysLeft !== null && daysLeft <= 0) status = 'expired';
  return { status, daysLeft, endsAt: hotel.subscription_ends_at };
}

async function handleGetSubscription(request, env, slug) {
  const auth = await requireAuth(request, env, slug, ['hotelier']);
  if (!auth.ok) return auth.response;
  const hotel = await env.DB.prepare(
    'SELECT plan, subscription_status, subscription_ends_at, billing_period, chambres FROM hotels WHERE slug = ?'
  ).bind(slug).first();
  if (!hotel) return json({ ok: false, error: 'Hôtel introuvable' }, 404);
  const { status, daysLeft, endsAt } = computeSubscriptionStatus(hotel);
  return json({
    ok: true,
    plan:          hotel.plan || 'small',
    status,
    daysLeft,
    endsAt,
    billingPeriod: hotel.billing_period,
    prices:        PLANS,
  });
}

async function handleAdminSetSubscription(request, env, slug) {
  const { plan, billing_period, action } = await request.json();
  if (action === 'expire') {
    await env.DB.prepare(
      `UPDATE hotels SET subscription_status = 'expired' WHERE slug = ?`
    ).bind(slug).run();
    return json({ ok: true });
  }
  const days    = billing_period === 'annual' ? 365 : 30;
  const endsAt  = new Date(Date.now() + days * 86400000).toISOString();
  await env.DB.prepare(
    `UPDATE hotels SET plan = ?, subscription_status = 'active', subscription_ends_at = ?, billing_period = ? WHERE slug = ?`
  ).bind(plan || 'small', endsAt, billing_period || 'monthly', slug).run();
  return json({ ok: true, endsAt });
}

async function handleMigrateSubscription(env) {
  const migrations = [
    `ALTER TABLE hotels ADD COLUMN plan TEXT DEFAULT 'small'`,
    `ALTER TABLE hotels ADD COLUMN subscription_status TEXT DEFAULT 'trial'`,
    `ALTER TABLE hotels ADD COLUMN subscription_ends_at TEXT`,
    `ALTER TABLE hotels ADD COLUMN billing_period TEXT`,
    `ALTER TABLE hotels ADD COLUMN chambres TEXT DEFAULT '1-5'`,
  ];
  const results = [];
  for (const sql of migrations) {
    try { await env.DB.prepare(sql).run(); results.push({ ok: true, sql }); }
    catch (e) { results.push({ ok: false, sql, error: String(e) }); } // colonne déjà présente
  }
  // Initialiser les hôtels existants sans abonnement
  await env.DB.prepare(
    `UPDATE hotels SET subscription_status = 'trial',
      subscription_ends_at = datetime('now', '+15 days')
     WHERE subscription_status IS NULL OR subscription_status = ''`
  ).run();
  return json({ ok: true, results });
}

function buildInitialConfig({ nom, ville, pays, adresse, telephone, whatsapp, email, hote_nom, wifi_reseau, wifi_mdp, bienvenue_fr, checkin, checkout }) {
  const esc = (s) => JSON.stringify(s || '');
  const bvnFr = bienvenue_fr || 'Bienvenue dans notre établissement.';

  // Construire le tableau telephones depuis les valeurs brutes "+221 77 123 45 67"
  function parseTel(str, label) {
    if (!str) return null;
    const parts = str.split(' ');
    const dialcode = parts[0] && parts[0].startsWith('+') ? parts[0] : '+221';
    const numero = parts[0].startsWith('+') ? parts.slice(1).join(' ') : str;
    return { dialcode, numero, label };
  }
  const telRow = parseTel(telephone, 'Réception');
  const waRow  = whatsapp && whatsapp !== telephone ? parseTel(whatsapp, 'WhatsApp') : null;
  const telephones = [telRow, waRow].filter(Boolean);
  const telephonesJson = JSON.stringify(telephones, null, 4);

  return `const CONFIG = {
  hotel: {
    nom:         ${esc(nom)},
    nom_court:   ${esc(nom.substring(0, 20))},
    ville:       ${esc(ville || 'Dakar')},
    pays:        ${esc(pays || 'Sénégal')},
    adresse:     ${esc(adresse || '')},
    telephone:   ${esc(telephone || '')},
    whatsapp:    ${esc(whatsapp || telephone || '')},
    telephones:  ${telephonesJson},
    email:       ${esc(email || '')},
    hote_nom:    ${esc(hote_nom || '')},
    logo_url:    "",
    cover_photo: "",
  },
  bienvenue: {
    texte_fr:  ${esc(bvnFr)},
    texte_en:  "Welcome to our establishment.",
    signature: "L'équipe",
  },
  pratique: {
    wifi_reseau: ${esc(wifi_reseau || '')}, wifi_mdp: ${esc(wifi_mdp || '')},
    checkin: ${esc(checkin || '14h00')}, checkout: ${esc(checkout || '11h00')},
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
