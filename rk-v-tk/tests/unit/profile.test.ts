import { describe, expect, it } from "vitest";
import { parseProfileInput } from "../../lib/domain/profile";

describe("profile input", () => {
  it("normalizes a username and optional display name", () => {
    expect(parseProfileInput({ username: " Rod_123 ", displayName: " Rod " }))
      .toEqual({ username: "rod_123", displayName: "Rod" });
    expect(parseProfileInput({ username: "rod", displayName: " " }).displayName).toBeNull();
    expect(parseProfileInput({ username: "rod" }).displayName).toBeNull();
  });

  it.each([null, [], "rod", {}, { username: "ab" }, { username: "a".repeat(31) },
    { username: "bad name" }, { username: "röd" }, { username: 12 },
    { username: "rod", userId: "someone-else" }, { username: "rod", cognitoSub: "fake" },
    { username: "rod", displayName: 1 }, { username: "rod", displayName: "a".repeat(81) },
    { username: "rod", displayName: "bad\u0000name" },
  ])("rejects invalid data: %j", (input) => {
    expect(() => parseProfileInput(input)).toThrow();
  });
});
