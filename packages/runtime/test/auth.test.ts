import { describe, expect, it } from "vitest";
import {
  assertAllowedEmailDomain,
  assertAllowedEmailDomains,
  emailToLinuxUser,
} from "../src/auth/linuxUser.js";

describe("linux user mapping", () => {
  it("maps configured email addresses to deterministic OpenCortex Linux users", () => {
    expect(emailToLinuxUser("Matt.Fox@acme.test", { OPENCORTEX_LINUX_USER_PREFIX: "" })).toBe("matt-fox");
  });

  it("rejects domains outside the configured allowlist", () => {
    expect(() => assertAllowedEmailDomain("person@example.com", "acme.test")).toThrow(/not allowed/);
  });

  it("allows any domain when no allowlist is configured", () => {
    expect(() => assertAllowedEmailDomains("person@example.com", [])).not.toThrow();
  });

  it("accepts any configured OpenCortex email domain", () => {
    expect(() =>
      assertAllowedEmailDomains("person@contractor.example.com", [
        "example.com",
        "contractor.example.com",
      ]),
    ).not.toThrow();
  });
});
