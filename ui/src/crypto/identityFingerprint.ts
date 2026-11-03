/** Short, comparable fingerprint for a public Holochain agent key. */
export async function formatAgentFingerprint(agent: Uint8Array | readonly number[]): Promise<string> {
  const keyBytes = agent instanceof Uint8Array ? agent : Uint8Array.from(agent);
  const digestInput = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(digestInput).set(keyBytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  const hex = Array.from(digest.slice(0, 10), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}
