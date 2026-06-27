/**
 * CONFIGURATION DU LIVRET D'ACCUEIL
 * Ce fichier est un modèle — les vraies données sont gérées via /admin
 * et stockées dans Cloudflare KV (servies dynamiquement par _worker.js)
 */

const CONFIG = {

  hotel: {
    nom:         "Nom de l'établissement",
    nom_court:   "Établissement",
    ville:       "Ville",
    pays:        "Sénégal",
    adresse:     "Adresse complète",
    telephone:   "+221 XX XXX XX XX",
    whatsapp:    "+221 XX XXX XX XX",
    email:       "contact@etablissement.sn",
    hote_nom:    "Prénom & Nom",
    cover_photo: "",
  },

  bienvenue: {
    texte_fr: `Bienvenue dans notre établissement.`,
    texte_en: `Welcome to our establishment.`,
    signature: "L'équipe",
  },

  pratique: {
    wifi_reseau:  "NomWiFi",
    wifi_mdp:     "MotDePasseWiFi",
    checkin:      "14h00",
    checkout:     "11h00",
    cles:         "Déposez les clés à la réception",
    cles_en:      "Leave keys at reception",
    regles: [],
  },

  chambres: {
    description_fr: "",
    description_en: "",
    equipements: [],
  },

  services: {
    liste: [],
  },

  restaurants: {
    liste: [],
  },

  transport: {
    options: [],
  },

  quartier: {
    description_fr: "",
    description_en: "",
    points_interet: [],
  },

  urgences: {
    contacts: [],
  },

  paiement: {
    methodes: [],
    note_fr: "",
    note_en: "",
  },

  depart: {
    instructions_fr: [],
    instructions_en: [],
  },

};

if (typeof applyConfig === 'function') applyConfig();
