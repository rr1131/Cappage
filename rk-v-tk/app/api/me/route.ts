import { authenticatedSubject } from "@/lib/auth/identity";
import { withDatabase } from "@/lib/db/client";
import { profileHandlers } from "@/lib/profiles/http";
import { profileRepository } from "@/lib/profiles/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = profileHandlers({
  authenticate: authenticatedSubject,
  find: (subject) => withDatabase((db) => profileRepository(db).findBySubject(subject)),
  create: (subject, input) => withDatabase((db) => profileRepository(db).create(subject, input)),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
