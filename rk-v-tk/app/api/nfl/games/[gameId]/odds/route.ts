import { nflHandlers } from "@/lib/odds/routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ gameId: string }> }) {
  return nflHandlers.odds(request, (await context.params).gameId);
}
