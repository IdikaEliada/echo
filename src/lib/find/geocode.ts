// Turn "near the main gate" or "Hostel B" into coordinates.
// Order: EchoBot's own landmarks, then places the user saved, then OpenStreetMap
// Nominatim (biased towards where the user last was).

import { httpFetch } from "../http";
import { distanceM, type LatLng } from "./geo";
import { curatedLandmarks } from "./places";

export type Resolved = LatLng & { label: string; source: "landmark" | "saved" | "osm" };

const NOMINATIM_URL = () => process.env.GEOCODE_URL?.trim() || "https://nominatim.openstreetmap.org/search";
const COUNTRY = () => process.env.FIND_COUNTRY?.trim() || "ng";
const UA = "EchoBot/0.1 (Walrus Memory chatbot; find-nearby)";

/** "near the main gate" -> "main gate" */
export function cleanPlaceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(i'?m|i am|am|we'?re)\s+/, "")
    .replace(/^(around|near|by|at|close to|beside|opposite|behind|inside|in)\s+/, "")
    .replace(/^the\s+/, "")
    .replace(/[.?!]+$/, "")
    .trim();
}

function score(query: string, name: string): number {
  const q = cleanPlaceText(query);
  const n = name.toLowerCase();
  if (!q) return 0;
  if (n === q) return 3;
  if (n.includes(q) || q.includes(n)) return 2;
  const qw = new Set(q.split(/\s+/).filter((w) => w.length > 2));
  const hits = n.split(/\s+/).filter((w) => qw.has(w)).length;
  return hits && hits >= Math.min(2, qw.size) ? 1 : 0;
}

export async function resolvePlace(
  text: string,
  opts: { near?: LatLng; saved?: (LatLng & { label: string })[] } = {},
): Promise<Resolved | null> {
  const q = text.trim();
  if (!q) return null;

  const pick = <T extends LatLng>(list: T[], name: (x: T) => string[]) => {
    let best: { item: T; s: number } | undefined;
    for (const item of list) {
      const s = Math.max(...name(item).map((n) => score(q, n)));
      if (s > 0 && (!best || s > best.s || (s === best.s && opts.near && distanceM(opts.near, item) < distanceM(opts.near, best.item)))) {
        best = { item, s };
      }
    }
    return best?.item;
  };

  const lm = pick(curatedLandmarks, (l) => [l.name, ...(l.aliases ?? [])]);
  if (lm) return { lat: lm.lat, lng: lm.lng, label: lm.name, source: "landmark" };

  const saved = pick(opts.saved ?? [], (s) => [s.label]);
  if (saved) return { lat: saved.lat, lng: saved.lng, label: saved.label, source: "saved" };

  try {
    const url = new URL(NOMINATIM_URL());
    url.searchParams.set("q", cleanPlaceText(q) || q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", COUNTRY());
    if (opts.near) {
      // ~15 km box around the user, preferred but not enforced.
      const d = 0.14;
      url.searchParams.set("viewbox", [opts.near.lng - d, opts.near.lat + d, opts.near.lng + d, opts.near.lat - d].join(","));
    }
    const res = await httpFetch(url.toString(), {
      headers: { "user-agent": UA, "accept-language": "en" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string; name?: string }[];
    if (!hit) return null;
    return {
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      label: hit.name || hit.display_name.split(",")[0],
      source: "osm",
    };
  } catch (err) {
    console.error(`[find] geocode failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
