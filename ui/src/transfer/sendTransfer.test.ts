import { describe, expect, it } from "vitest";
import { buildDownloadUrl } from "./downloadUrl";

describe("buildDownloadUrl", () => {
  it("builds a complete root-hosted download address", () => {
    expect(buildDownloadUrl("https://filenymous.eu", "/", "parcel-123", "aes-456")).toBe(
      "https://filenymous.eu/#parcel-123:aes-456",
    );
  });

  it("keeps a configured deployment sub-path", () => {
    expect(buildDownloadUrl("https://example.test", "/next", "parcel-123", "aes-456")).toBe(
      "https://example.test/next/#parcel-123:aes-456",
    );
  });
});
