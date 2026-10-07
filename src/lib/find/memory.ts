// What EchoBot remembers for finding places, all on Walrus Memory:
//
//   per user  (…-finder)   saved spots, places they passed on and why, visits + ratings
//   per user  (…-settings) the last search, so "not this one" works on any server instance
//   everyone  (community)  visit ratings, so a good barber rises for the next student
//
// Entries are one line each, readable by a person and parseable by code.

import { hash, ns, recall, remember } from "../memory";
import type { LatLng } from "./geo";

export type Spot = LatLng & { label: string };
export type Skip = { id: string; name: string; reason?: string };
export type Visit = { id: string; name: string; stars: number; tags: string[] };

export type FinderMemory = {
  spots: Spot[];
  skips: Skip[];
  visits: Visit[];
  /** Raw lines, for the memory panel / debug output. */
  lines: string[];
};

const num = "(-?\\d+(?:\\.\\d+)?)";
const SPOT = new RegExp(`^\\[spot\\] (.+?) @ ${num},${num}`);
const SKIP = /^\[skip\] (.+?) \| id=(\S+)(?: \| reason: (.+))?$/;
const VISIT = /^\[visit\] (.+?) \| id=(\S+) \| stars=(\d)(?: \| tags=(.*))?$/;

export function parseFinder(lines: string[]): FinderMemory {
  const out: FinderMemory = { spots: [], skips: [], visits: [], lines };
  for (const line of lines) {
    let m = line.match(SPOT);
    if (m) {
      if (!out.spots.some((s) => s.label.toLowerCase() === m![1].toLowerCase())) {
        out.spots.push({ label: m[1], lat: Number(m[2]), lng: Number(m[3]) });
      }
      continue;
    }
    m = line.match(SKIP);
    if (m) {
      out.skips.push({ name: m[1], id: m[2], reason: m[3] });
      continue;
    }
    m = line.match(VISIT);
    if (m) {
      // Recall is newest-first for "recent", so keep the first rating per place.
      if (!out.visits.some((v) => v.id === m![2])) {
        out.visits.push({ name: m[1], id: m[2], stars: Number(m[3]), tags: m[4] ? m[4].split(",").filter(Boolean) : [] });
      }
    }
  }
  return out;
}

export async function loadFinder(user: string, about: string): Promise<FinderMemory> {
  const [relevant, recent] = await Promise.all([
    recall(ns.finder(user), `${about} places saved, passed on, visited, rated`, 20),
    recall(ns.finder(user), "usual spot saved location", 8, { sort: "recent" }),
  ]);
  const seen = new Set<string>();
  const lines = [...recent, ...relevant].map((r) => r.text).filter((t) => !seen.has(t) && seen.add(t));
  return parseFinder(lines);
}

const clean = (s: string) => s.replace(/[\n|]+/g, " ").trim().slice(0, 120);

export function saveSpot(user: string, spot: Spot) {
  return remember(ns.finder(user), `[spot] ${clean(spot.label)} @ ${spot.lat.toFixed(5)},${spot.lng.toFixed(5)}`);
}

export function saveSkip(user: string, place: { id: string; name: string }, reason?: string) {
  return remember(
    ns.finder(user),
    `[skip] ${clean(place.name)} | id=${place.id}${reason?.trim() ? ` | reason: ${clean(reason)}` : ""}`,
  );
}

export async function saveVisit(user: string, place: { id: string; name: string }, stars: number, tags: string[] = []) {
  const s = Math.min(5, Math.max(1, Math.round(stars)));
  const t = tags.map((x) => clean(x).toLowerCase()).filter(Boolean).slice(0, 5).join(",");
  await Promise.all([
    remember(ns.finder(user), `[visit] ${clean(place.name)} | id=${place.id} | stars=${s}${t ? ` | tags=${t}` : ""}`),
    // One rating per user per place: the rater hash lets us keep only their latest.
    remember(ns.community(), `[rating] ${place.id} | ${clean(place.name)} | stars=${s}${t ? ` | tags=${t}` : ""} | by=${hash(user).slice(0, 10)}`),
  ]);
}

export type Rating = { avg: number; count: number; tags: string[] };

const RATING = /^\[rating\] (\S+) \| .+? \| stars=(\d)(?: \| tags=([^|]*))? \| by=(\S+)/;

/** EchoBot ratings for these places, one vote per person (their newest). */
export async function communityRatings(about: string, ids: string[]): Promise<Map<string, Rating>> {
  const out = new Map<string, Rating>();
  if (!ids.length) return out;
  const hits = await recall(ns.community(), `${about} ratings`, 50, { sort: "recent" });
  const wanted = new Set(ids);
  const votes = new Map<string, Map<string, { stars: number; tags: string[] }>>();
  for (const h of hits) {
    const m = h.text.match(RATING);
    if (!m || !wanted.has(m[1])) continue;
    const byPlace = votes.get(m[1]) ?? new Map();
    if (!byPlace.has(m[4])) byPlace.set(m[4], { stars: Number(m[2]), tags: m[3] ? m[3].trim().split(",").filter(Boolean) : [] });
    votes.set(m[1], byPlace);
  }
  for (const [id, byUser] of votes) {
    const list = [...byUser.values()];
    const tagCount = new Map<string, number>();
    list.flatMap((v) => v.tags).forEach((t) => tagCount.set(t, (tagCount.get(t) ?? 0) + 1));
    out.set(id, {
      avg: Math.round((list.reduce((a, v) => a + v.stars, 0) / list.length) * 10) / 10,
      count: list.length,
      tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t),
    });
  }
  return out;
}

// ---- Last search (for "not this one" and follow-ups) ----

export type LastSearch = {
  text: string;
  category: string;
  keywords: string[];
  openNow: boolean;
  radius: number;
  origin: LatLng & { label: string };
  index: number;
};

export function saveLastSearch(user: string, last: LastSearch) {
  return remember(ns.settings(user), `[find-last] ${JSON.stringify(last)}`);
}

export async function loadLastSearch(user: string): Promise<LastSearch | null> {
  const hits = await recall(ns.settings(user), "find-last last place search", 3, { sort: "recent" });
  for (const h of hits) {
    if (!h.text.startsWith("[find-last] ")) continue;
    try {
      return JSON.parse(h.text.slice(12)) as LastSearch;
    } catch {}
  }
  return null;
}
