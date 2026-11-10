import "server-only";

import { parseProfileInput, ProfileError, type Profile, type ProfileInput } from "../domain/profile";

type Dependencies = {
  authenticate: (request: Request) => Promise<string>;
  find: (subject: string) => Promise<Profile | null>;
  create: (subject: string, input: ProfileInput) => Promise<{ profile: Profile; created: boolean }>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", Vary: "Authorization" } });
}

function failure(error: unknown) {
  if (error instanceof ProfileError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Database errors can contain credentials or user data. Never serialize them.
  return json({ error: { code: "SERVICE_UNAVAILABLE", message: "Profiles are temporarily unavailable. Try again." } }, 503);
}

export function profileHandlers(deps: Dependencies) {
  return {
    async GET(request: Request) {
      try {
        const subject = await deps.authenticate(request);
        const profile = await deps.find(subject);
        if (!profile) throw new ProfileError("PROFILE_NOT_FOUND", "Create your profile to continue.", 404);
        return json({ profile });
      } catch (error) { return failure(error); }
    },
    async POST(request: Request) {
      try {
        const subject = await deps.authenticate(request);
        const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") {
          throw new ProfileError("UNSUPPORTED_MEDIA_TYPE", "Send application/json.", 415);
        }
        let body: unknown;
        try { body = await request.json(); }
        catch { throw new ProfileError("INVALID_JSON", "Provide valid JSON.", 400); }
        const result = await deps.create(subject, parseProfileInput(body));
        return json({ profile: result.profile }, result.created ? 201 : 200);
      } catch (error) { return failure(error); }
    },
  };
}
