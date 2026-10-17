/** French user-facing copy (pure, unit-tested). */
import type { ShareSummary } from "./messages";

export function formatBytes(n: number): string {
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(1).replace(".", ",") : v} ${u[i]}`;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expiré";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

export function statusLabel(s: ShareSummary, now = Date.now()): string {
  const pct = s.totalBytes ? Math.min(100, Math.floor((s.confirmedBytes / s.totalBytes) * 100)) : 0;
  const unlimited = s.maxDownloads > 100;
  const count = unlimited ? `${s.downloads}` : `${s.downloads}/${s.maxDownloads}`;
  switch (s.status) {
    case "secret":
      return s.once ? "Lien secret créé · lecture unique" : `Lien secret créé · lisible jusqu'à expiration (${formatRemaining(s.expiresAt - now)})`;
    case "starting":
      return "Connexion au relais…";
    case "waiting":
      return s.downloads ? `Téléchargé (${count}) · en attente d'un autre destinataire` : "En attente du destinataire";
    case "connecting":
      return "Connexion au destinataire…";
    case "transferring":
      return `Envoi en cours : ${pct} %`;
    case "streaming":
      return "Lecture en streaming chez le destinataire";
    case "reconnecting":
      return "Reconnexion au relais…";
    case "delivered":
      return `Téléchargé (${count})`;
    case "complete":
      return "Terminé : le destinataire a téléchargé le fichier";
    case "expired":
      return s.downloads ? `Expiré · téléchargé ${s.downloads} fois` : "Expiré sans téléchargement";
    case "locked":
      return "Bloqué : trop de mots de passe erronés";
    case "stopped":
      return "Partage arrêté";
    case "error":
      return `Erreur : ${errorMessage(s.error)}`;
    default:
      return s.status;
  }
}

export function errorMessage(code?: string): string {
  switch (code) {
    case "signal-unreachable":
    case "signal-timeout":
      return "relais Filenymous injoignable (connexion coupée, ou extension non autorisée par le relais).";
    case "origin-not-allowed":
      return "le relais n'autorise pas encore cette extension.";
    case "too-many-attempts":
      return "trop de mots de passe erronés.";
    case "expired":
      return "le lien a expiré.";
    default:
      return code || "inconnue";
  }
}

export const VAULT_ERRORS: Record<string, string> = {
  "rate-limited": "Trop de demandes : réessayez dans une minute.",
  "too-large": "Texte trop long (64 Ko maximum).",
  invalid: "Le serveur a refusé la demande.",
  denied: "Le serveur refuse les requêtes de l'extension (origine non autorisée).",
  network: "Serveur Filenymous injoignable. Vérifiez votre connexion.",
  empty: "Aucun texte sélectionné.",
};

export const FETCH_ERRORS: Record<string, string> = {
  unsupported: "Ce contenu n'est pas récupérable (adresse blob:, file: ou interne au navigateur). Utilisez la fenêtre Filenymous pour choisir le fichier.",
  blocked: "Impossible de récupérer ce fichier depuis ce site.",
  http: "Le site a refusé le téléchargement du fichier.",
  "too-large": "Fichier trop volumineux pour le clic droit (1 Go maximum). Utilisez la fenêtre Filenymous pour le choisir depuis votre disque.",
  empty: "Le fichier est vide.",
};

export const KEEP_OPEN =
  "Gardez le navigateur ouvert jusqu'au téléchargement : le fichier part directement de votre ordinateur, rien n'est stocké sur un serveur.";
