// Security rule (CLAUDE.md §3): CSRF origin check for mutating requests
import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../src/origin";

describe("isAllowedOrigin", () => {
  it("allows requests without an Origin header", () => {
    expect(isAllowedOrigin(null, "linkos.app", "https://linkos.app")).toBe(true);
  });
  it("allows the same host", () => {
    expect(isAllowedOrigin("https://linkos.app", "linkos.app")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000", "localhost:3000")).toBe(true);
  });
  it("rejects another site", () => {
    expect(isAllowedOrigin("https://evil.example", "linkos.app", "https://linkos.app")).toBe(false);
    expect(isAllowedOrigin("https://linkos.app.evil.example", "linkos.app", "https://linkos.app")).toBe(false);
  });
  it("allows the configured public origin when a proxy rewrites the host (Codespaces)", () => {
    const pub = "https://ws-abc-3000.app.github.dev";
    expect(isAllowedOrigin(pub, "localhost:3000", pub)).toBe(true);
    expect(isAllowedOrigin("https://other-3000.app.github.dev", "localhost:3000", pub)).toBe(false);
  });
  it("matches APP_ORIGIN by scheme and port, not just hostname", () => {
    expect(isAllowedOrigin("http://linkos.app", "internal:3000", "https://linkos.app")).toBe(false);
    expect(isAllowedOrigin("https://linkos.app:8443", "internal:3000", "https://linkos.app")).toBe(false);
  });
  it("never widens access for a malformed Origin or APP_ORIGIN", () => {
    expect(isAllowedOrigin("not a url", "linkos.app", "https://linkos.app")).toBe(false);
    expect(isAllowedOrigin("https://evil.example", "linkos.app", "::bad::")).toBe(false);
  });
});
