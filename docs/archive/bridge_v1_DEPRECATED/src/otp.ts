/**
 * In-memory OTP store — TOTP-based, no persistence.
 * Each OTP is single-use and expires in 10 minutes.
 */

import { authenticator } from "otplib";
import { sendEmail, sendSms } from "./notify.js";

const TTL_MS  = 10 * 60 * 1000; // 10 minutes
const secrets = new Map<string, { secret: string; expires: number }>();

authenticator.options = { step: 600, window: 1 }; // 10-min window, allow 1 drift

export async function createOtp(contact: string): Promise<void> {
  const secret  = authenticator.generateSecret();
  const expires = Date.now() + TTL_MS;
  secrets.set(contact, { secret, expires });

  const code = authenticator.generate(secret);

  if (contact.startsWith("+")) {
    await sendSms(contact, "", `Votre code Filenymous : ${code} (valable 10 min)`);
  } else {
    await sendEmail(contact, "", `Votre code Filenymous : ${code} (valable 10 min)`);
  }
}

export function verifyOtp(contact: string, code: string): boolean {
  const entry = secrets.get(contact);
  if (!entry) return false;
  if (Date.now() > entry.expires) { secrets.delete(contact); return false; }
  const valid = authenticator.verify({ token: code, secret: entry.secret });
  if (valid) secrets.delete(contact); // single-use
  return valid;
}
