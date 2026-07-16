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

-- Index de performance
CREATE INDEX IF NOT EXISTS idx_tickets_hotel    ON tickets(hotel_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ticket  ON messages(ticket_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_users_hotel      ON users(hotel_slug);
CREATE INDEX IF NOT EXISTS idx_users_email      ON users(hotel_slug, email);
