-- ─────────────────────────────────────────────
-- Welkomeo · par Assenka — Cloudflare D1 Schema
-- Base : livret-db
-- ─────────────────────────────────────────────

-- Hôtels (métadonnées établissement)
CREATE TABLE IF NOT EXISTS hotels (
  slug                  TEXT PRIMARY KEY,
  nom                   TEXT NOT NULL,
  ville                 TEXT DEFAULT '',
  pays                  TEXT DEFAULT '',
  adresse               TEXT DEFAULT '',
  telephone             TEXT DEFAULT '',
  whatsapp              TEXT DEFAULT '',
  created_at            TEXT NOT NULL,
  -- Abonnement
  plan                  TEXT DEFAULT 'small',         -- 'small' | 'large'
  subscription_status   TEXT DEFAULT 'trial',         -- 'trial' | 'active' | 'expired'
  subscription_ends_at  TEXT,                          -- ISO date
  billing_period        TEXT,                          -- 'monthly' | 'annual'
  chambres              TEXT DEFAULT '1-5'             -- from registration
);

-- Utilisateurs (hôteliers + gestionnaires)
-- role : 'hotelier' | 'gestionnaire'
-- active : 1 = actif, 0 = révoqué
-- email_verified : 1 = email confirmé, 0 = en attente
CREATE TABLE IF NOT EXISTS users (
  id                 TEXT PRIMARY KEY,
  hotel_slug         TEXT NOT NULL,
  nom                TEXT NOT NULL,
  email              TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'gestionnaire',
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  email_verified     INTEGER NOT NULL DEFAULT 1, -- DEFAULT 1 pour les comptes existants
  verification_token TEXT,
  FOREIGN KEY (hotel_slug) REFERENCES hotels(slug)
);

-- Migration à exécuter sur la base existante (une seule fois) :
-- npx wrangler d1 execute welkomeo-db --remote --command "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1; ALTER TABLE users ADD COLUMN verification_token TEXT;"

-- Tickets d'incident
CREATE TABLE IF NOT EXISTS tickets (
  id          TEXT PRIMARY KEY,
  hotel_slug  TEXT NOT NULL,
  guest_name  TEXT DEFAULT 'Visiteur',
  guest_email TEXT DEFAULT '',
  guest_phone TEXT DEFAULT '',
  guest_room  TEXT DEFAULT '',
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'received',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (hotel_slug) REFERENCES hotels(slug)
);

-- Messages des tickets
-- from_role : 'guest' | 'hotel'
-- from_user_id : null pour les vacanciers, id de l'utilisateur hôtel
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    TEXT NOT NULL,
  from_role    TEXT NOT NULL,
  from_user_id TEXT,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

-- Séjours (multi-voyageurs par établissement)
CREATE TABLE IF NOT EXISTS stays (
  id           TEXT PRIMARY KEY,
  hotel_slug   TEXT NOT NULL,
  guest_name   TEXT NOT NULL,
  guest_email  TEXT DEFAULT '',
  guest_phone  TEXT DEFAULT '',
  room         TEXT DEFAULT '',
  checkin      TEXT NOT NULL,   -- YYYY-MM-DD
  checkout     TEXT NOT NULL,   -- YYYY-MM-DD
  created_at   TEXT NOT NULL,
  FOREIGN KEY (hotel_slug) REFERENCES hotels(slug)
);

-- Migration à exécuter une seule fois :
-- npx wrangler d1 execute livret-db --remote --command "CREATE TABLE IF NOT EXISTS stays (id TEXT PRIMARY KEY, hotel_slug TEXT NOT NULL, guest_name TEXT NOT NULL, guest_email TEXT DEFAULT '', guest_phone TEXT DEFAULT '', room TEXT DEFAULT '', civility TEXT DEFAULT '', checkin TEXT NOT NULL, checkout TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (hotel_slug) REFERENCES hotels(slug));"
-- npx wrangler d1 execute livret-db --remote --command "CREATE INDEX IF NOT EXISTS idx_stays_hotel ON stays(hotel_slug, checkout);"
-- Si la table stays existe déjà, ajouter la colonne civility :
-- npx wrangler d1 execute livret-db --remote --command "ALTER TABLE stays ADD COLUMN civility TEXT DEFAULT '';"

-- Recommandations hôtelier (favoris "Autour de moi")
-- category : 'restaurant' | 'loisirs' | 'services'
CREATE TABLE IF NOT EXISTS recommendations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_slug   TEXT NOT NULL,
  category     TEXT NOT NULL,
  name         TEXT NOT NULL,
  address      TEXT DEFAULT '',
  phone        TEXT DEFAULT '',
  url          TEXT DEFAULT '',     -- site web ou lien Google Maps
  note         TEXT DEFAULT '',     -- commentaire de l'hôtelier
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (hotel_slug) REFERENCES hotels(slug)
);

-- Migration à exécuter une seule fois :
-- npx wrangler d1 execute livret-db --remote --command "CREATE TABLE IF NOT EXISTS recommendations (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_slug TEXT NOT NULL, category TEXT NOT NULL, name TEXT NOT NULL, address TEXT DEFAULT '', phone TEXT DEFAULT '', note TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (hotel_slug) REFERENCES hotels(slug));"
-- Migration ajout colonne url :
-- npx wrangler d1 execute livret-db --remote --command "ALTER TABLE recommendations ADD COLUMN url TEXT DEFAULT '';"

-- Index de performance
CREATE INDEX IF NOT EXISTS idx_tickets_hotel    ON tickets(hotel_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_users_hotel      ON users(hotel_slug);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(hotel_slug, email);
CREATE INDEX IF NOT EXISTS idx_stays_hotel      ON stays(hotel_slug, checkout);
CREATE INDEX IF NOT EXISTS idx_reco_hotel       ON recommendations(hotel_slug, category);
