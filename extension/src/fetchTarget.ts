/** Turns a right-clicked image / media / link target into a File (fetched by the extension). */

export const MAX_FETCH_BYTES = 1024 ** 3; // 1 Gio : held in memory until the recipient downloads it

export type FetchErrorCode = "unsupported" | "blocked" | "http" | "too-large" | "empty";

export class FetchTargetError extends Error {
  constructor(readonly code: FetchErrorCode, readonly origin?: string, readonly status?: number) {
    super(code);
  }
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-icon": "ico", "video/mp4": "mp4", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/wav": "wav", "application/pdf": "pdf", "application/zip": "zip",
  "text/plain": "txt", "text/html": "html", "application/json": "json",
};

function sanitize(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
}

function fromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/);
  return plain ? (plain[1] ?? plain[2] ?? "").trim() : null;
}

/** File name for a fetched target: Content-Disposition, then the URL path, then a generic name. */
export function fileNameFor(url: string, mime: string, disposition: string | null = null, kind: "image" | "media" | "link" = "link"): string {
  const type = (mime || "").split(";")[0]!.trim().toLowerCase();
  const ext = EXT[type];
  let name = sanitize(fromDisposition(disposition) ?? "");
  if (!name) {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
        try {
          name = sanitize(decodeURIComponent(last));
        } catch {
          name = sanitize(last);
        }
      }
    } catch {
      /* invalid URL: generic name */
    }
  }
  if (!name) name = kind === "image" ? "image" : kind === "media" ? "media" : "fichier";
  if (ext && !/\.[A-Za-z0-9]{1,5}$/.test(name)) name = `${name}.${ext}`;
  return name;
}

/** `https://host` for http(s) targets, used for the optional host permission. */
export function targetOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.hostname}` : null;
  } catch {
    return null;
  }
}

/** Match pattern for permissions.request (any port of that host). */
export function originPattern(origin: string): string {
  return `${origin}/*`;
}

export async function fetchAsFile(url: string, kind: "image" | "media" | "link", fetchImpl: typeof fetch = fetch): Promise<File> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchTargetError("unsupported");
  }
  const isData = u.protocol === "data:";
  if (!isData && u.protocol !== "http:" && u.protocol !== "https:") throw new FetchTargetError("unsupported");
  const origin = isData ? undefined : `${u.protocol}//${u.hostname}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { credentials: "omit", referrerPolicy: "no-referrer" });
  } catch {
    // No host permission and no CORS (or offline): the background asks for access to this site.
    throw new FetchTargetError("blocked", origin);
  }
  if ((res.status === 401 || res.status === 403) && !isData) {
    // Behind a login: retry with the user's session (needs the host permission).
    try {
      const again = await fetchImpl(url, { credentials: "include", referrerPolicy: "no-referrer" });
      if (again.ok) res = again;
    } catch {
      /* keep the first answer */
    }
  }
  if (!res.ok) throw new FetchTargetError("http", origin, res.status);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_FETCH_BYTES) throw new FetchTargetError("too-large", origin);
  const blob = await res.blob();
  if (blob.size > MAX_FETCH_BYTES) throw new FetchTargetError("too-large", origin);
  if (blob.size === 0) throw new FetchTargetError("empty", origin);
  const type = blob.type || res.headers.get("content-type") || "application/octet-stream";
  return new File([blob], fileNameFor(url, type, res.headers.get("content-disposition"), kind), { type: type.split(";")[0]! });
}
