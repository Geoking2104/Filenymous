/**
 * Email (SendGrid/SMTP) + SMS (Twilio) notification helpers.
 * No data is logged or persisted beyond the send operation.
 */

import nodemailer from "nodemailer";
import twilio     from "twilio";

// ── Email ─────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport(
  process.env.SENDGRID_API_KEY
    ? {
        host:   "smtp.sendgrid.net",
        port:   587,
        auth: {
          user: "apikey",
          pass: process.env.SENDGRID_API_KEY,
        },
      }
    : {
        // Dev fallback: Ethereal (catches emails without sending)
        host: "smtp.ethereal.email",
        port: 587,
        auth: {
          user: process.env.ETHEREAL_USER ?? "test@ethereal.email",
          pass: process.env.ETHEREAL_PASS ?? "testpass",
        },
      }
);

const FROM_EMAIL = process.env.FROM_EMAIL ?? "noreply@filenymous.eu";
const FROM_NAME  = "Filenymous";

export async function sendEmail(
  to:      string,
  link:    string,
  message: string
): Promise<void> {
  const isOtp = !link.includes("?d=");

  const subject = isOtp
    ? "Votre code de vérification Filenymous"
    : "Vous avez reçu un fichier via Filenymous";

  const html = isOtp
    ? `<p>${message}</p>`
    : `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="color:#fff;margin:0;font-size:24px">⟁ Filenymous</h1>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
          <h2 style="font-size:18px;color:#1e1b4b;margin-bottom:8px">Vous avez reçu un fichier</h2>
          ${message ? `<p style="color:#6b7280;background:#f5f3ff;padding:12px;border-radius:8px;margin-bottom:16px">${message.replace(/\n/g,"<br/>")}</p>` : ""}
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">
            Télécharger le fichier
          </a>
          <p style="font-size:12px;color:#9ca3af;margin-top:16px">
            Ce lien est à usage unique et expire automatiquement.<br/>
            Chiffrement E2E AES-256 — Filenymous ne peut pas lire vos fichiers.
          </p>
        </div>
      </div>`;

  await transporter.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
}

// ── SMS ───────────────────────────────────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const FROM_PHONE = process.env.TWILIO_FROM ?? "+15000000000";

export async function sendSms(
  to:      string,
  link:    string,
  message: string
): Promise<void> {
  const isOtp = !link.includes("?d=");
  const body  = isOtp
    ? message
    : `Filenymous : vous avez reçu un fichier.${message ? " " + message.slice(0, 80) : ""} → ${link}`;

  if (!process.env.TWILIO_ACCOUNT_SID) {
    console.warn(`[bridge] SMS (dev mode, Twilio non configuré) → ${to}: ${body}`);
    return;
  }

  await twilioClient.messages.create({ body, from: FROM_PHONE, to });
}
