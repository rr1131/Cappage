import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SimpleJwksCache, type JwkWithKid } from "aws-jwt-verify/jwk";
import { FetchError } from "aws-jwt-verify/error";
import { authenticatedSubject } from "../../lib/auth/identity";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kty: "RSA", kid: "test-key", use: "sig", alg: "RS256" } as JwkWithKid;
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool";

function token(overrides: Record<string, unknown> = {}, key = privateKey) {
  const payload = {
    sub: "verified-cognito-sub", iss: issuer, client_id: "test-client", token_use: "access",
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides,
  };
  const content = [ { alg: "RS256", kid: "test-key" }, payload ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), key).toString("base64url")}`;
}
const request = (jwt: string) => new Request("http://localhost/api/me", { headers: { Authorization: `Bearer ${jwt}` } });

beforeAll(() => {
  vi.stubEnv("COGNITO_USER_POOL_ID", "us-east-1_TestPool");
  vi.stubEnv("COGNITO_CLIENT_ID", "test-client");
  // Only key retrieval is stubbed. Signatures and claims use the real verifier.
  vi.spyOn(SimpleJwksCache.prototype, "getJwk").mockResolvedValue(jwk);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("verified Cognito identity", () => {
  it("returns the signed subject", async () => {
    await expect(authenticatedSubject(request(token()))).resolves.toBe("verified-cognito-sub");
  });
  it("rejects missing and malformed bearer credentials", async () => {
    await expect(authenticatedSubject(new Request("http://localhost/api/me"))).rejects.toMatchObject({ status: 401 });
    await expect(authenticatedSubject(request("not-a-jwt"))).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { exp: 1 }, { iss: "https://attacker.example" }, { client_id: "another-client" },
    { token_use: "id", aud: "test-client" }, { sub: "" },
  ])("rejects invalid claims: %j", async (claims) => {
    await expect(authenticatedSubject(request(token(claims)))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects a forged signature", async () => {
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await expect(authenticatedSubject(request(token({}, otherKey)))).rejects.toMatchObject({ status: 401 });
  });
  it("fails closed on a JWKS outage without misclassifying it as invalid credentials", async () => {
    vi.mocked(SimpleJwksCache.prototype.getJwk).mockRejectedValueOnce(new FetchError("https://example.test", "offline"));
    await expect(authenticatedSubject(request(token()))).rejects.toBeInstanceOf(FetchError);
  });
});
