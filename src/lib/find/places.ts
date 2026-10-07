// Where places come from:
//   1. EchoBot's own verified list (src/data/places.json), checked in person.
//      These carry phone numbers, landmark notes and last-mile hints that maps miss.
//   2. OpenStreetMap through the Overpass API: free, open data, no scraping.
// Nothing is ever made up: a place exists in one of these sources or it isn't shown.

import seed from "../../data/places.json";
import { CATEGORIES, categoryById, type Category } from "./categories";
import { distanceM, type LatLng } from "./geo";
import { httpFetch } from "../http";

export type Place = {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  phone?: string;
  /** OpenStreetMap opening_hours syntax, e.g. "Mo-Sa 08:00-20:00". */
  hours?: string;
  address?: string;
  /** e.g. "opposite GTBank, green gate". */
  landmark?: string;
  /** e.g. "behind the lecture hall, ask for Chidi". */
  lastMile?: string;
  keywords: string[];
  source: "echobot" | "osm";
  /** ISO date the place was last checked in person (EchoBot list only). */
  verified?: string;
};

export type Landmark = { name: string; lat: number; lng: number; aliases?: string[] };

type SeedFile = { places?: (Omit<Place, "source" | "keywords"> & { keywords?: string[] })[]; landmarks?: Landmark[] };
const data = seed as unknown as SeedFile;

export const curatedPlaces: Place[] = (data.places ?? []).map((p) => ({
  ...p,
  keywords: p.keywords ?? [],
  source: "echobot",
}));

export const curatedLandmarks: Landmark[] = data.landmarks ?? [];

const OVERPASS_URL = () => process.env.OVERPASS_URL?.trim() || "https://overpass-api.de/api/interpreter";
const UA = "EchoBot/0.1 (Walrus Memory chatbot; find-nearby)";

// Overpass is a shared free service: cache answers so repeat searches in the
// same area (most of a campus) cost nothing.
const CACHE_TTL_MS = 15 * 60 * 1000;
const g = globalThis as unknown as { __ebOverpass?: Map<string, { at: number; data: Promise<Place[]> }> };
const cache = (g.__ebOverpass ??= new Map());

function tagFilters(cat: Category): string[] {
  return cat.osm.map((spec) => {
    const [key, values] = spec.split("=");
    return `["${key}"~"^(${values})$"]`;
  });
}

/** Overpass QL for every category tag around a point. */
function query(cat: Category, at: LatLng, radius: number): string {
  const around = `(around:${Math.round(radius)},${at.lat.toFixed(6)},${at.lng.toFixed(6)})`;
  const parts = tagFilters(cat).map((f) => `nwr${f}${around};`);
  return `[out:json][timeout:15];(${parts.join("")});out center tags 60;`;
}

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

export async function overpass(ql: string): Promise<OsmElement[]> {
  const res = await httpFetch(OVERPASS_URL(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: `data=${encodeURIComponent(ql)}`,
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as { elements?: OsmElement[] };
  return json.elements ?? [];
}

function fromOsm(el: OsmElement, cat: Category): Place | null {
  const t = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  const name = t.name ?? t["name:en"] ?? t.brand;
  if (lat === undefined || lng === undefined || !name) return null;
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const address = [street, t["addr:city"] ?? t["addr:suburb"]].filter(Boolean).join(", ");
  const keywords = [t.cuisine, t.shop, t.amenity, t.craft, t.description]
    .filter(Boolean)
    .flatMap((v) => v!.split(/[;,]/))
    .map((v) => v.trim().replace(/_/g, " "))
    .filter(Boolean);
  return {
    id: `osm:${el.type}/${el.id}`,
    name,
    category: cat.id,
    lat,
    lng,
    phone: t.phone ?? t["contact:phone"] ?? t["contact:whatsapp"],
    hours: t.opening_hours,
    address: address || undefined,
    keywords,
    source: "osm",
  };
}

export async function osmPlaces(cat: Category, at: LatLng, radius: number): Promise<Place[]> {
  const key = `${cat.id}:${at.lat.toFixed(3)}:${at.lng.toFixed(3)}:${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = overpass(query(cat, at, radius)).then((els) =>
    els.map((el) => fromOsm(el, cat)).filter((p): p is Place => !!p),
  );
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  if (cache.size > 500) cache.clear();
  return data;
}

/**
 * Every known place of a category within `radius` metres.
 * OpenStreetMap failing (rate limit, outage) still leaves EchoBot's own list.
 */
export async function placesNear(catId: string, at: LatLng, radius: number): Promise<{ places: Place[]; osmOk: boolean }> {
  const cat = categoryById(catId) ?? CATEGORIES[0];
  const mine = curatedPlaces.filter((p) => p.category === cat.id && distanceM(at, p) <= radius);
  let osm: Place[] = [];
  let osmOk = true;
  try {
    osm = await osmPlaces(cat, at, radius);
  } catch (err) {
    osmOk = false;
    console.error(`[find] Overpass failed: ${err instanceof Error ? err.message : err}`);
  }
  // Prefer our verified entry when both sources list the same shop.
  const deduped = osm.filter(
    (o) => !mine.some((m) => distanceM(m, o) < 40 && similar(m.name, o.name)),
  );
  return { places: [...mine, ...deduped], osmOk };
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function similar(a: string, b: string) {
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length > 4 && y.includes(x)) || (y.length > 4 && x.includes(y));
}

export function findCurated(id: string): Place | undefined {
  return curatedPlaces.find((p) => p.id === id);
}
