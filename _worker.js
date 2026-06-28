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

    // ── /{slug}/gestion → page dédiée gestion des incidents ──
    if (sub === 'gestion' || sub === 'gestion.html') {
      return fetchAsset(env, url.origin + '/gestion.html');
    }

    // ── /{slug}/carte → carte d'accueil imprimable ──
    if (sub === 'carte' || sub === 'carte.html') {
      return fetchAsset(env, url.origin + '/carte.html');
    }

    // ── /{slug}/incident → créer ticket ──
    if (sub === 'incident' && request.method === 'POST') {
      return handleCreateTicket(request, env, slug);
    }

    // ── /{slug}/guest-stay → enregistrer les infos du séjour en cours ──
    if (sub === 'guest-stay' && request.method === 'POST') {
      return handleSaveGuestStay(request, env, slug);
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

  // ── Cron quotidien : rappel check-out J-1 ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheckoutReminders(env));
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
        error: 'Un établissement "' + nom + '" existe déjà. Contactez le support si c\'est le vôtre.',
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
// ─────────────────────────────────────────────
// SÉJOUR EN COURS — sauvegarde infos guest
// ─────────────────────────────────────────────
async function handleSaveGuestStay(request, env, slug) {
  const secret = request.headers.get('X-Auth-Secret') || '';
  if (!env.AUTH_SECRET || secret !== env.AUTH_SECRET) {
    return json({ ok: false, error: 'Non autorisé' }, 401);
  }
  try {
    const { nom, email, checkout } = await request.json();
    if (!email || !checkout) return json({ ok: false, error: 'Email et date de checkout requis' }, 400);
    await env.CONFIG_KV.put(
      `hotel:${slug}:current_stay`,
      JSON.stringify({ nom: nom || '', email, checkout, saved: new Date().toISOString() })
    );
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ─────────────────────────────────────────────
// CRON — envoi des rappels check-out J-1
// ─────────────────────────────────────────────
async function runCheckoutReminders(env) {
  if (!env.RESEND_API_KEY) return; // Resend non configuré

  // Récupérer la liste de tous les hôtels
  const indexRaw = await env.CONFIG_KV.get('hotels:index') || '[]';
  const hotels = JSON.parse(indexRaw);

  // Date de demain (checkout = demain → on envoie aujourd'hui)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

  for (const h of hotels) {
    try {
      const stayRaw = await env.CONFIG_KV.get(`hotel:${h.slug}:current_stay`);
      if (!stayRaw) continue;
      const stay = JSON.parse(stayRaw);
      if (stay.checkout !== tomorrowStr) continue; // pas demain

      // Charger le nom de l'hôtel depuis la config
      const configRaw = await env.CONFIG_KV.get(`hotel:${h.slug}:config`) || '';
      const nomMatch = configRaw.match(/nom:\s*"([^"]+)"/);
      const hotelNom = nomMatch ? nomMatch[1] : h.nom || 'votre hôtel';

      await sendCheckoutReminder(env, stay, hotelNom, h.slug);

      // Supprimer le séjour après envoi (évite les doublons)
      await env.CONFIG_KV.delete(`hotel:${h.slug}:current_stay`);
    } catch (_) { /* continue les autres hôtels */ }
  }
}

async function sendCheckoutReminder(env, stay, hotelNom, slug) {
  const guestNom = stay.nom || 'Cher(e) hôte';
  const dateStr  = new Date(stay.checkout + 'T12:00:00').toLocaleDateString('fr-FR', {
    weekday:'long', day:'numeric', month:'long'
  });

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rappel check-out — ${hotelNom}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital@0;1&display=swap');
  body { margin:0; padding:0; background:#f4f6f9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  .wrap { max-width:540px; margin:32px auto; background:#fff; border-radius:20px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.08); }
  .cover { background:linear-gradient(135deg,#1a3a5c 0%,#2c6ea1 100%); padding:36px 32px 28px; text-align:center; }
  .cover-ico { font-size:48px; margin-bottom:10px; }
  .cover-hotel { font-family:'Playfair Display',Georgia,serif; color:#fff; font-size:24px; font-weight:400; margin:0 0 6px; }
  .cover-sub { color:rgba(255,255,255,.7); font-size:13px; }
  .body { padding:32px; }
  .greeting { font-size:17px; color:#1a3a5c; font-weight:600; margin-bottom:8px; }
  .intro { font-size:15px; color:#555; line-height:1.6; margin-bottom:24px; }
  .checklist-title { font-size:13px; font-weight:700; color:#1a3a5c; text-transform:uppercase; letter-spacing:.6px; margin-bottom:14px; }
  .item { display:flex; align-items:flex-start; gap:12px; margin-bottom:13px; }
  .item-num { width:28px; height:28px; border-radius:50%; background:#1a3a5c; color:#fff; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .item-text { font-size:14px; color:#444; line-height:1.5; padding-top:5px; }
  .checkout-box { background:#f0fdf4; border:1px solid #86efac; border-radius:14px; padding:18px 20px; margin:24px 0; text-align:center; }
  .checkout-time { font-size:32px; font-weight:700; color:#15803d; }
  .checkout-label { font-size:13px; color:#15803d; margin-top:4px; }
  .footer { background:#1a3a5c; padding:22px 32px; text-align:center; }
  .footer-thanks { font-family:'Playfair Display',Georgia,serif; color:#fff; font-size:18px; font-style:italic; margin-bottom:8px; }
  .footer-sub { color:rgba(255,255,255,.6); font-size:12px; line-height:1.6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="cover">
    <div class="cover-ico">🌅</div>
    <div class="cover-hotel">${hotelNom}</div>
    <div class="cover-sub">Votre check-out est demain</div>
  </div>
  <div class="body">
    <div class="greeting">Bonjour ${guestNom},</div>
    <div class="intro">Votre séjour touche bientôt à sa fin. Nous avons été ravis de vous recevoir et espérons que vous avez passé un excellent moment parmi nous.<br><br>Voici nos derniers conseils pour un check-out réussi :</div>

    <div class="checklist-title">✅ Checklist de départ</div>

    <div class="item"><div class="item-num">1</div><div class="item-text">Vérifiez que vous n'avez rien oublié — armoires, tiroirs, salle de bain, chargeurs</div></div>
    <div class="item"><div class="item-num">2</div><div class="item-text">Éteignez les lumières et la climatisation</div></div>
    <div class="item"><div class="item-num">3</div><div class="item-text">Fermez toutes les fenêtres et portes</div></div>
    <div class="item"><div class="item-num">4</div><div class="item-text">Déposez vos clés selon les instructions reçues à l'arrivée</div></div>
    <div class="item"><div class="item-num">5</div><div class="item-text">N'hésitez pas à nous contacter si vous avez besoin de garder vos bagages</div></div>

    <div class="checkout-box">
      <div class="checkout-label">Heure limite de check-out</div>
      <div class="checkout-time" id="co-time">demain matin</div>
      <div class="checkout-label">Le ${dateStr}</div>
    </div>

    <div class="intro" style="margin-bottom:0">Un petit avis en ligne nous aiderait énormément à faire connaître notre établissement. Merci pour votre confiance, et à bientôt ! 🌟</div>
  </div>
  <div class="footer">
    <div class="footer-thanks">Merci pour votre confiance.</div>
    <div class="footer-sub">${hotelNom}<br>Ce message est automatique — merci de ne pas y répondre.</div>
  </div>
</div>
</body>
</html>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${hotelNom} <onboarding@resend.dev>`,
      to: [stay.email],
      subject: `Votre check-out demain — ${hotelNom}`,
      html,
    }),
  });
}

// ── Helpers email HTML partagé ──
function emailBase(hotelNom, headerColor, headerIcon, headerTitle) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px 12px}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.10)}
.cover{background:${headerColor};padding:28px 24px 22px;text-align:center}
.cover-ico{font-size:36px;margin-bottom:8px}
.cover-hotel{color:#fff;font-size:20px;font-weight:700;letter-spacing:.3px}
.cover-sub{color:rgba(255,255,255,.65);font-size:13px;margin-top:4px}
.body{padding:24px}
.greeting{font-size:16px;font-weight:600;margin-bottom:12px}
.intro{font-size:14px;color:#444;line-height:1.6;margin-bottom:18px}
.ticket-box{background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:12px;padding:16px 20px;margin-bottom:18px;text-align:center}
.ticket-label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#64748b;font-weight:600;margin-bottom:4px}
.ticket-id{font-size:28px;font-weight:800;font-family:monospace;color:#1e293b;letter-spacing:2px}
.ticket-subject{font-size:13px;color:#64748b;margin-top:4px}
.msg-box{background:#f1f5f9;border-radius:10px;padding:14px 16px;margin-bottom:18px;font-size:14px;color:#334155;line-height:1.6;white-space:pre-wrap}
.cta{display:block;background:${headerColor};color:#fff;text-decoration:none;text-align:center;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;margin-bottom:18px}
.footer{border-top:1px solid #f1f5f9;padding:16px 24px;text-align:center}
.footer-thanks{font-size:13px;color:#64748b}
.footer-sub{font-size:11px;color:#94a3b8;margin-top:4px}
</style></head><body>
<div class="card">
<div class="cover"><div class="cover-ico">${headerIcon}</div><div class="cover-hotel">${hotelNom}</div><div class="cover-sub">${headerTitle}</div></div>
<div class="body">`;
}
function emailFooter(hotelNom) {
  return `</div><div class="footer"><div class="footer-thanks">Merci de votre confiance.</div><div class="footer-sub">${hotelNom} — Ce message est automatique.</div></div></div></body></html>`;
}
async function resendEmail(env, to, subject, html, from) {
  if (!env.RESEND_API_KEY) return { error: 'RESEND_API_KEY manquante' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const body = await r.text();
    return { status: r.status, body };
  } catch(e) {
    return { error: String(e) };
  }
}

// 1. Confirmation au vacancier après création du ticket
async function sendTicketConfirmationToGuest(env, ticket, hotelNom, slug) {
  const ticketUrl = `https://livret-accueil-2wc.pages.dev/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '🎫', 'Votre signalement a bien été reçu')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro">Nous avons bien reçu votre signalement et nous vous en remercions. Notre équipe va traiter votre demande dans les meilleurs délais.</div>`
    + `<div class="ticket-box"><div class="ticket-label">Votre numéro de ticket</div><div class="ticket-id">#${ticket.id}</div><div class="ticket-subject">${ticket.subject}</div></div>`
    + `<div class="intro">Vous pouvez suivre l'avancement de votre demande et échanger avec nous en cliquant ci-dessous :</div>`
    + `<a class="cta" href="${ticketUrl}">Suivre mon ticket →</a>`
    + emailFooter(hotelNom);
  return await resendEmail(env, ticket.guestEmail, `Ticket #${ticket.id} créé — ${ticket.subject}`, html, `${hotelNom} <onboarding@resend.dev>`);
}

// 2. Notification à l'hôtelier quand le vacancier crée un ticket ou répond
async function sendTicketNotificationToHotel(env, ticket, hotelNom, hotelEmail, newMessage, slug) {
  const adminUrl = `https://livret-accueil-2wc.pages.dev/${slug}/admin`;
  const html = emailBase(hotelNom, '#dc2626', '⚠️', 'Nouveau signalement reçu')
    + `<div class="greeting">Nouveau message sur le ticket #${ticket.id}</div>`
    + `<div class="intro"><strong>De :</strong> ${ticket.guestName}${ticket.guestPhone ? ' · ' + ticket.guestPhone : ''}<br><strong>Objet :</strong> ${ticket.subject}</div>`
    + `<div class="ticket-box"><div class="ticket-label">Message reçu</div></div>`
    + `<div class="msg-box">${newMessage}</div>`
    + `<a class="cta" href="${adminUrl}">Répondre depuis l'admin →</a>`
    + emailFooter(hotelNom);
  await resendEmail(env, hotelEmail, `⚠️ Ticket #${ticket.id} — ${ticket.subject}`, html, `Livret Digital <onboarding@resend.dev>`);
}

// 3. Notification au vacancier quand l'hôtelier répond
async function sendTicketReplyToGuest(env, ticket, hotelNom, replyText, slug) {
  const ticketUrl = `https://livret-accueil-2wc.pages.dev/${slug}/ticket/${ticket.id}`;
  const html = emailBase(hotelNom, '#2c3e50', '💬', 'Réponse à votre signalement')
    + `<div class="greeting">Bonjour ${ticket.guestName},</div>`
    + `<div class="intro"><strong>${hotelNom}</strong> a répondu à votre ticket <strong>#${ticket.id}</strong> — ${ticket.subject} :</div>`
    + `<div class="msg-box">${replyText}</div>`
    + `<div class="intro">Vous pouvez continuer la conversation ou consulter l'historique complet en cliquant ci-dessous :</div>`
    + `<a class="cta" href="${ticketUrl}">Voir la conversation →</a>`
    + emailFooter(hotelNom);
  await resendEmail(env, ticket.guestEmail, `Réponse à votre ticket #${ticket.id} — ${hotelNom}`, html, `${hotelNom} <onboarding@resend.dev>`);
}

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
    const { guestName, guestPhone, guestEmail, subject, message } = data;
    if (!subject || !message) return json({ ok: false, error: 'Objet et message requis.' }, 400);

    let id = genTicketId();
    let attempts = 0;
    while (await env.CONFIG_KV.get('hotel:' + slug + ':ticket:' + id) && attempts < 10) {
      id = genTicketId(); attempts++;
    }

    const ticket = {
      id, slug, status: 'received',
      guestName:  guestName  || 'Visiteur',
      guestPhone: guestPhone || '',
      guestEmail: guestEmail || '',
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

    // Récupérer infos hôtel pour les emails
    const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
    const hotelAuth = authRaw ? JSON.parse(authRaw) : {};
    const hotelNom = hotelAuth.nom || slug;
    const hotelEmail = hotelAuth.email || '';

    // Email de confirmation au vacancier (si email fourni)
    let emailSent = false;
    let resendDebug = null;
    if (guestEmail && env.RESEND_API_KEY) {
      resendDebug = await sendTicketConfirmationToGuest(env, ticket, hotelNom, slug);
      emailSent = resendDebug && resendDebug.status === 200;
    } else if (!env.RESEND_API_KEY) {
      resendDebug = 'RESEND_API_KEY non disponible dans env';
    }
    // Notification à l'hôtelier
    if (hotelEmail && env.RESEND_API_KEY) {
      await sendTicketNotificationToHotel(env, ticket, hotelNom, hotelEmail, message, slug);
    }

    return json({ ok: true, id, ticketUrl: '/' + slug + '/ticket/' + id, emailSent, resendDebug });
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

    // Notifications email
    if (env.RESEND_API_KEY) {
      const authRaw = await env.CONFIG_KV.get('hotel:' + slug + ':auth');
      const hotelAuth = authRaw ? JSON.parse(authRaw) : {};
      const hotelNom   = hotelAuth.nom   || slug;
      const hotelEmail = hotelAuth.email || '';

      if (from === 'guest' && hotelEmail) {
        // Vacancier répond → notifier l'hôtelier
        await sendTicketNotificationToHotel(env, ticket, hotelNom, hotelEmail, text, slug);
      } else if (from === 'hotel' && ticket.guestEmail) {
        // Hôtelier répond → notifier le vacancier
        await sendTicketReplyToGuest(env, ticket, hotelNom, text, slug);
      }
    }

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
