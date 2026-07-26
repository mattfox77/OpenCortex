import { describe, expect, it } from "vitest";
import { assertAllowedEmailDomain, emailToLinuxUser } from "../src/auth/linuxUser.js";

describe("linux user mapping", () => {
  it("maps DSN email addresses to deterministic Diwan Linux users", () => {
    expect(emailToLinuxUser("Matt.Fox@dsn.com", { DIWAN_LINUX_USER_PREFIX: "" })).toBe("matt-fox");
  });

  it("rejects non-DSN domains", () => {
    expect(() => assertAllowedEmailDomain("person@example.com", "dsn.com")).toThrow(/not allowed/);
  });
});
