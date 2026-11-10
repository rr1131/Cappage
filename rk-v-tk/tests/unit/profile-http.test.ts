import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileError } from "../../lib/domain/profile";
import { profileHandlers } from "../../lib/profiles/http";

const profile = { id: "internal-id", username: "rod", displayName: null,
  createdAt: "2026-11-06T12:00:00.000Z", updatedAt: "2026-11-06T12:00:00.000Z" };
const deps = { authenticate: vi.fn(), find: vi.fn(), create: vi.fn() };
const handlers = profileHandlers(deps);
const request = (body: unknown = { username: "Rod" }) => new Request("http://localhost/api/me", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  deps.authenticate.mockResolvedValue("verified-subject");
  deps.find.mockResolvedValue(profile);
  deps.create.mockResolvedValue({ profile, created: true });
});

describe("profile HTTP contract", () => {
  it("reads only the verified subject and disables caching", async () => {
    const response = await handlers.GET(new Request("http://localhost/api/me?userId=someone-else"));
    expect(deps.find).toHaveBeenCalledWith("verified-subject");
    expect(await response.json()).toEqual({ profile });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns 404 before registration", async () => {
    deps.find.mockResolvedValue(null);
    expect((await handlers.GET(request())).status).toBe(404);
  });
  it("creates with the verified identity and normalized data", async () => {
    expect((await handlers.POST(request())).status).toBe(201);
    expect(deps.create).toHaveBeenCalledWith("verified-subject", { username: "rod", displayName: null });
  });
  it("returns 200 for a retry", async () => {
    deps.create.mockResolvedValue({ profile, created: false });
    expect((await handlers.POST(request())).status).toBe(200);
  });
  it("rejects supplied identity fields", async () => {
    expect((await handlers.POST(request({ username: "rod", userId: "victim" }))).status).toBe(422);
    expect(deps.create).not.toHaveBeenCalled();
  });
  it("does not access the database when authentication fails", async () => {
    deps.authenticate.mockRejectedValue(new ProfileError("UNAUTHORIZED", "Sign in.", 401));
    expect((await handlers.GET(request())).status).toBe(401);
    expect((await handlers.POST(request())).status).toBe(401);
    expect(deps.find).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });
  it("reports username conflicts", async () => {
    deps.create.mockRejectedValue(new ProfileError("USERNAME_TAKEN", "Taken.", 409));
    const response = await handlers.POST(request());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("USERNAME_TAKEN");
  });
  it("rejects malformed JSON and incorrect content types", async () => {
    expect((await handlers.POST(new Request("http://localhost/api/me", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    }))).status).toBe(400);
    expect((await handlers.POST(new Request("http://localhost/api/me", {
      method: "POST", body: "{}",
    }))).status).toBe(415);
    expect(deps.create).not.toHaveBeenCalled();
  });
  it("redacts database and auth infrastructure errors", async () => {
    deps.find.mockRejectedValue(new Error("postgresql://secret@host user data"));
    const response = await handlers.GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    deps.authenticate.mockRejectedValue(new Error("JWKS fetch failed"));
    expect((await handlers.POST(request())).status).toBe(503);
    expect(deps.create).not.toHaveBeenCalled();
  });
});
