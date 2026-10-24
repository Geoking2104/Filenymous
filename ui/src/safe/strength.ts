/**
 * Local password strength estimate (no dictionary download): character-pool
 * entropy, discounted for repeats, sequences and very common passwords.
 * An estimate, not a guarantee — shown as such in the UI.
 */
const COMMON = new Set([
  "password", "123456", "123456789", "12345678", "12345", "qwerty", "azerty", "111111", "123123", "abc123",
  "password1", "motdepasse", "admin", "welcome", "iloveyou", "letmein", "monkey", "dragon", "soleil", "bonjour",
  "000000", "1234567890", "qwertyuiop", "azertyuiop", "football", "secret", "chocolat", "loulou", "doudou", "marseille",
]);

export function entropyBits(pw: string): number {
  if (!pw) return 0;
  if (COMMON.has(pw.toLowerCase())) return 4;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  if (/[^\x00-\x7f]/.test(pw)) pool += 60;
  // Effective length: repeated characters and simple sequences count less.
  let eff = 0;
  const chars = [...pw];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!.codePointAt(0)!;
    const p = i > 0 ? chars[i - 1]!.codePointAt(0)! : -99;
    if (c === p) eff += 0.25;
    else if (Math.abs(c - p) === 1) eff += 0.5;
    else eff += 1;
  }
  const uniq = new Set(chars).size;
  const bits = eff * Math.log2(Math.max(pool, 2));
  return Math.round(Math.min(bits, uniq * Math.log2(Math.max(pool, 2)) * 1.5));
}

/** Passphrases: several words separated by spaces/dashes get credit per word. */
export function estimateBits(pw: string): number {
  const words = pw.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  const byWords = words.length >= 4 ? words.length * 11 : 0;
  return Math.max(entropyBits(pw), byWords);
}

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export function strengthLevel(bits: number): StrengthLevel {
  if (bits < 28) return 0;
  if (bits < 45) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/** Master password minimum. */
export const MASTER_MIN_BITS = 60;
/** Item passwords under this count as weak in the security dashboard. */
export const WEAK_BITS = 45;

export function generatePassword(len = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=?";
  const out: string[] = [];
  const r = new Uint32Array(len);
  crypto.getRandomValues(r);
  for (let i = 0; i < len; i++) out.push(alphabet[r[i]! % alphabet.length]!);
  return out.join("");
}
