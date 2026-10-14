/** Local, privacy-light user-agent summary: "Chrome 129 · Windows". */
export function parseUserAgent(ua: string, platformHint = ""): string {
  let browser = "Web";
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/Edg(?:A|iOS)?\/(\d+)/))) browser = `Edge ${m[1]}`;
  else if ((m = ua.match(/OPR\/(\d+)/))) browser = `Opera ${m[1]}`;
  else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) browser = `Samsung Internet ${m[1]}`;
  else if ((m = ua.match(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = ua.match(/CriOS\/(\d+)/))) browser = `Chrome ${m[1]}`;
  else if ((m = ua.match(/Chrome\/(\d+)/))) browser = `Chrome ${m[1]}`;
  else if ((m = ua.match(/Version\/(\d+)(?:\.\d+)*.*Safari/))) browser = `Safari ${m[1]}`;
  else if (/Safari/.test(ua)) browser = "Safari";

  let os = "";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && platformHint === "touch")) os = "iPad";
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? "Android" : "Android (tablette)";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return os ? `${browser} · ${os}` : browser;
}

export function describeDevice(): string {
  if (typeof navigator === "undefined") return "";
  const touch = typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1 ? "touch" : "";
  return parseUserAgent(navigator.userAgent || "", touch);
}
