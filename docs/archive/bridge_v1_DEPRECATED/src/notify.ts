/**
 * Email via Nodemailer en mode DIRECT.
 *
 * Le bridge résout lui-même les enregistrements MX du domaine destinataire
 * et livre le mail directement sur le serveur du destinataire (Gmail, Outlook…)
 * sans aucun service tiers, sans API key, sans limite d'envoi imposée.
 *
 * Pour une bonne délivrabilité en production, configurer :
 *   - Un enregistrement SPF sur le domaine expéditeur :
 *       v=spf1 ip4:<IP-publique-du-serveur> ~all
 *   - Un PTR (reverse DNS) sur l'IP du serveur → nom de domaine
 *   - DKIM (optionnel mais recommandé — voir DKIM_PRIVATE_KEY ci-dessous)
 */

import nodemailer  from "nodemailer";
import { createSign } from "crypto";

// ── Transporter — livraison SMTP directe ──────────────────────────────────────
const transporter = nodemailer.createTransport({
  direct: true,                                       // résolution MX + livraison directe
  name:   process.env.MAIL_HOSTNAME ?? "localhost",   // hostname annoncé dans EHLO
  port:   25,
  tls:    { rejectUnauthorized: false },              // certains serveurs ont des certs auto-signés
  logger: process.env.NODE_ENV !== "production",
  debug:  false,
});

const FROM_EMAIL = process.env.FROM_EMAIL ?? "noreply@filenymous.app";
const FROM_NAME  = process.env.FROM_NAME  ?? "Filenymous";

// ── DKIM (optionnel — améliore la délivrabilité) ──────────────────────────────
// Pour activer : générer une paire de clés RSA 2048 bits,
// publier la clé publique en DNS (TXT mail._domainkey.<domaine>)
// et injecter la clé privée dans DKIM_PRIVATE_KEY.
const dkimOptions = process.env.DKIM_PRIVATE_KEY
  ? {
      domainName: process.env.DKIM_DOMAIN    ?? "filenymous.app",
      keySelector: process.env.DKIM_SELECTOR ?? "mail",
      privateKey:  process.env.DKIM_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }
  : undefined;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface EmailOptions {
  to:          string;
  fromName:    string;
  fromContact: string;
  fileNames:   string;
  link:        string;
  lang:        string;
}

// ── sendEmail ─────────────────────────────────────────────────────────────────
export async function sendEmail(opts: EmailOptions): Promise<void> {
  const { to, fromName, fromContact, fileNames, link, lang } = opts;

  const isFr = lang === "fr";

  const subject = isFr
    ? `${fromName} vous a envoyé un fichier`
    : `${fromName} sent you a file`;

  const ctaLabel    = isFr ? "Télécharger le fichier"   : "Download file";
  const expireNote  = isFr
    ? "Ce lien expire quand l'expéditeur ferme son onglet — ouvrez-le rapidement."
    : "This link expires when the sender closes their tab — open it promptly.";
  const e2eNote = isFr
    ? "Chiffrement E2E AES-256-GCM — Filenymous ne peut pas lire vos fichiers."
    : "End-to-end AES-256-GCM — Filenymous cannot read your files.";
  const fromLabel  = isFr ? "De la part de" : "From";
  const filesLabel = isFr ? "Fichier(s)"    : "File(s)";

  const html = `<!DOCTYPE html>
<html lang="${isFr ? "fr" : "en"}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%">

        <tr><td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:28px 32px;border-radius:12px 12px 0 0;text-align:center">
          <span style="font-size:28px;color:#fff;font-weight:800;letter-spacing:-0.03em">⟁ Filenymous</span>
        </td></tr>

        <tr><td style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
          <h2 style="margin:0 0 8px;font-size:20px;color:#1e1b4b">
            ${isFr ? "Vous avez reçu un fichier" : "You have a file waiting"}
          </h2>

          <table width="100%" cellpadding="8" cellspacing="0" style="background:#f5f3ff;border-radius:8px;margin:16px 0">
            <tr>
              <td style="font-size:13px;color:#6b7280;white-space:nowrap;padding-right:12px">${fromLabel}</td>
              <td style="font-size:13px;color:#1e1b4b;font-weight:600">${escHtml(fromName)}${fromContact ? ` &lt;${escHtml(fromContact)}&gt;` : ""}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#6b7280;white-space:nowrap">${filesLabel}</td>
              <td style="font-size:13px;color:#1e1b4b">${escHtml(fileNames)}</td>
            </tr>
          </table>

          <div style="text-align:center;margin:24px 0">
            <a href="${link}"
               style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:15px;font-weight:600">
              ${ctaLabel} →
            </a>
          </div>

          <p style="font-size:12px;color:#9ca3af;margin:0 0 6px">⏱ ${expireNote}</p>
          <p style="font-size:12px;color:#9ca3af;margin:0">🔒 ${e2eNote}</p>
        </td></tr>

        <tr><td style="padding:16px;text-align:center">
          <span style="font-size:11px;color:#9ca3af">
            Filenymous — transfert P2P chiffré ·
            <a href="https://geoking2104.github.io/Filenymous/" style="color:#6366f1;text-decoration:none">filenymous.app</a>
          </span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const info = await transporter.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject,
    html,
    ...(dkimOptions ? { dkim: dkimOptions } : {}),
  });

  // En mode dev (Ethereal fallback automatique de Nodemailer)
  if (process.env.NODE_ENV !== "production") {
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) console.log(`[bridge/dev] Preview email: ${previewUrl}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
