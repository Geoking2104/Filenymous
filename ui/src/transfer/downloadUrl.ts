/**
 * Build the receiver-facing URL carried by copy/share actions and QR codes.
 * The AES key stays in the URL fragment, so it is never sent to the web server.
 */
export function buildDownloadUrl(
  origin: string,
  basePath: string,
  parcelEhB64: string,
  aesKeyB64: string,
): string {
  const base = basePath.startsWith("/") ? basePath : `/${basePath}`;
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${origin}${normalizedBase}#${parcelEhB64}:${aesKeyB64}`;
}
