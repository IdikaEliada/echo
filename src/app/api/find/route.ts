import { z } from "zod";
import { directions, findNearby, nextPick, saveSpot, saveVisit } from "@/lib/find";
import { rateLimit } from "@/lib/rate-limit";
import { getWebUser } from "@/lib/web-user";

export const maxDuration = 60;

const Lat = z.number().min(-90).max(90);
const Lng = z.number().min(-180).max(180);
const Point = z.object({ lat: Lat, lng: Lng });

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    text: z.string().trim().min(1).max(500),
    location: Point.extend({ accuracy: z.number().min(0).max(100_000).optional() }).nullish(),
  }),
  z.object({ action: z.literal("next"), reason: z.string().max(200).optional() }),
  z.object({
    action: z.literal("directions"),
    from: Point,
    place: Point.extend({
      id: z.string().max(80),
      name: z.string().max(120),
      category: z.string().max(40),
      landmark: z.string().max(200).optional(),
      lastMile: z.string().max(200).optional(),
    }),
  }),
  z.object({
    action: z.literal("rate"),
    place: z.object({ id: z.string().max(80), name: z.string().max(120) }),
    stars: z.number().int().min(1).max(5),
    tags: z.array(z.string().max(30)).max(5).default([]),
  }),
  z.object({ action: z.literal("save-spot"), label: z.string().trim().min(1).max(60), lat: Lat, lng: Lng }),
]);

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const body = parsed.data;

  const user = await getWebUser();
  const wait = rateLimit(user, "chat");
  if (wait) return Response.json({ error: `You're going fast. Try again in ${wait}s.` }, { status: 429 });

  try {
    switch (body.action) {
      case "search":
        return Response.json(await findNearby({ user, text: body.text, location: body.location }));
      case "next":
        return Response.json(await nextPick(user, body.reason));
      case "directions":
        return Response.json(await directions(body.from, { ...body.place, keywords: [], source: "osm" }));
      case "rate":
        await saveVisit(user, body.place, body.stars, body.tags);
        return Response.json({ ok: true });
      case "save-spot":
        await saveSpot(user, { label: body.label, lat: body.lat, lng: body.lng });
        return Response.json({ ok: true });
    }
  } catch (err) {
    console.error("[find] failed:", err);
    return Response.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
