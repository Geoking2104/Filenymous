/**
 * Passkey unlock through the WebAuthn PRF extension: the authenticator
 * returns a secret derived from (credential, salt) only after user
 * verification. That secret (never assertion data) is HKDF'd into a KEK.
 */
// Local helpers: keep @noble/* and the wordlist out of the page bundle.
function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

type Caps = Record<string, boolean>;

/** True only when the browser positively reports PRF support. */
export async function passkeyPrfSupported(): Promise<boolean> {
  try {
    const PKC = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Caps> } }).PublicKeyCredential;
    if (!PKC?.getClientCapabilities || !window.isSecureContext) return false;
    const caps = await PKC.getClientCapabilities();
    return caps["extension:prf"] === true;
  } catch {
    return false;
  }
}

function rand(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

type PrfOut = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

async function evaluate(credId: string, salt: string): Promise<Uint8Array> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: "public-key", id: fromB64u(credId) as Uint8Array<ArrayBuffer> }],
      userVerification: "required",
      timeout: 120_000,
      extensions: { prf: { eval: { first: fromB64u(salt) as Uint8Array<ArrayBuffer> } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = (cred?.getClientExtensionResults() as PrfOut | undefined)?.prf?.results?.first;
  if (!first) throw new Error("prf-unavailable");
  return new Uint8Array(first);
}

/** Registers a new passkey for this vault and returns its PRF secret. */
export async function createPasskey(label: string): Promise<{ credId: string; salt: string; prf: Uint8Array }> {
  const salt = b64u(rand(32));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Filenymous" },
      user: { id: rand(16), name: label, displayName: label },
      challenge: rand(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 120_000,
      extensions: { prf: { eval: { first: fromB64u(salt) as Uint8Array<ArrayBuffer> } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelled");
  const ext = cred.getClientExtensionResults() as PrfOut;
  if (ext.prf?.enabled === false) throw new Error("prf-unavailable");
  const credId = b64u(new Uint8Array(cred.rawId));
  // Some authenticators only evaluate PRF on get(), not on create().
  const first = ext.prf?.results?.first;
  const prf = first ? new Uint8Array(first) : await evaluate(credId, salt);
  return { credId, salt, prf };
}

export function passkeySecret(credId: string, salt: string): Promise<Uint8Array> {
  return evaluate(credId, salt);
}
