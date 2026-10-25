import { describe, expect, it } from "vitest";
import { encodeCard, handleFor, inboxIdFor, inboxSecret, newIdentity, publicKeys } from "./crypto";
import { CONTACT_INVITE_PREFIX, buildContactInvite, handleOfCard, isContactInviteHash, parseContactInvite } from "./invite";
import { needsBackupReminder } from "./persist";
import { serviceRoute } from "../home/routes";

async function card() {
  const id = newIdentity();
  const pub = publicKeys(id);
  const inbox = await inboxIdFor(await inboxSecret(id));
  return { card: encodeCard({ ...pub, inbox }), pub };
}

describe("contact invites", () => {
  it("round-trips a public card through a link (and its reply form)", async () => {
    const { card: c } = await card();
    const url = buildContactInvite("https://filenymous.eu/app/#safe", c);
    expect(url).toBe(`https://filenymous.eu/app/${CONTACT_INVITE_PREFIX}${c}`);
    const hash = url.slice(url.indexOf("#"));
    expect(isContactInviteHash(hash)).toBe(true);
    expect(parseContactInvite(hash)).toEqual({ card: c, reply: false });
    const back = buildContactInvite("https://filenymous.eu/app/", c, true);
    expect(parseContactInvite(back.slice(back.indexOf("#")))).toEqual({ card: c, reply: true });
  });

  it("rejects anything that is not a well-formed card", async () => {
    expect(parseContactInvite("#safe")).toBeNull();
    expect(parseContactInvite(`${CONTACT_INVITE_PREFIX}fny1.short`)).toBeNull();
    expect(parseContactInvite(`${CONTACT_INVITE_PREFIX}%E0%A4%A`)).toBeNull();
    expect(() => buildContactInvite("https://x/", "nope")).toThrow();
    expect(await handleOfCard("fny1.nope")).toBeNull();
  });

  it("shows the same short handle as the vault", async () => {
    for (let i = 0; i < 5; i++) {
      const { card: c, pub } = await card();
      expect(await handleOfCard(c)).toBe(await handleFor(pub.ed, pub.x));
    }
  });

  it("routes invite links to the Coffre-fort", async () => {
    const { card: c } = await card();
    expect(serviceRoute(`${CONTACT_INVITE_PREFIX}${c}`)).toBe("safe");
    expect(serviceRoute("#safe")).toBe("safe");
    expect(serviceRoute("#coffre")).toBe("safe");
  });
});

describe("backup reminder", () => {
  it("shows once there is data and no backup yet, until dismissed", () => {
    expect(needsBackupReminder(0, undefined, false)).toBe(false);
    expect(needsBackupReminder(1, undefined, false)).toBe(true);
    expect(needsBackupReminder(3, Date.now(), false)).toBe(false);
    expect(needsBackupReminder(3, undefined, true)).toBe(false);
  });
});
