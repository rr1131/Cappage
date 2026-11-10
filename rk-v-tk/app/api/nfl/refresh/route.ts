import { nflHandlers } from "@/lib/odds/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = nflHandlers.refresh;
