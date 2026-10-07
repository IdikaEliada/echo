// Landmark-based walking directions.
//
// A routing engine (OSRM) gives the real route; we attach real landmarks from
// EchoBot's list and OpenStreetMap to each turn and write the steps ourselves.
// No LLM is involved, so a step or landmark can't be invented: every name in
// the output comes from route data or a map record.

import { httpFetch } from "../http";
import { bearing, compass, distanceM, formatDistance, mapsLink, walkMinutes, type LatLng } from "./geo";
import { curatedLandmarks, overpass, type Place } from "./places";

const ROUTING_URL = () => process.env.ROUTING_URL?.trim() || "https://routing.openstreetmap.de/routed-foot/route/v1/foot";

export type Directions = {
  steps: string[];
  distance: number;
  minutes: number;
  /** [lat, lng] pairs for drawing the route. */
  line: [number, number][];
  mapsUrl: string;
  routed: boolean;
};

type OsrmStep = {
  distance: number;
  name: string;
  maneuver: { type: string; modifier?: string; location: [number, number]; bearing_after?: number };
};

type OsrmResponse = {
  code: string;
  routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[] }[];
};

type Mark = LatLng & { name: string };

/** Named things along the route that a person would recognise. */
async function landmarksAlong(from: LatLng, to: LatLng): Promise<Mark[]> {
  const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  const radius = Math.min(2500, distanceM(from, to) / 2 + 150);
  const own: Mark[] = curatedLandmarks.filter((l) => distanceM(mid, l) <= radius);
  try {
    const ql =
      `[out:json][timeout:10];(` +
      ["amenity", "shop", "bank", "tourism", "building", "office", "leisure"]
        .map((k) => `nwr["name"]["${k}"](around:${Math.round(radius)},${mid.lat.toFixed(6)},${mid.lng.toFixed(6)});`)
        .join("") +
      `);out center tags 150;`;
    const els = await overpass(ql);
    const osm = els
      .map((e) => ({ name: e.tags?.name ?? "", lat: e.lat ?? e.center?.lat ?? NaN, lng: e.lon ?? e.center?.lon ?? NaN }))
      .filter((m) => m.name && Number.isFinite(m.lat));
    return [...own, ...osm];
  } catch {
    return own;
  }
}

function nearestMark(at: LatLng, marks: Mark[], exclude: string, max = 45): Mark | undefined {
  let best: { m: Mark; d: number } | undefined;
  for (const m of marks) {
    if (m.name === exclude) continue;
    const d = distanceM(at, m);
    if (d <= max && (!best || d < best.d)) best = { m, d };
  }
  return best?.m;
}

function turnWord(modifier?: string): string {
  switch (modifier) {
    case "left":
    case "sharp left":
      return "Turn left";
    case "right":
    case "sharp right":
      return "Turn right";
    case "slight left":
      return "Bear left";
    case "slight right":
      return "Bear right";
    case "uturn":
      return "Turn around";
    default:
      return "Continue straight";
  }
}

function street(name: string) {
  return name ? ` onto ${name}` : "";
}

export async function directions(from: LatLng, place: Place): Promise<Directions> {
  const mapsUrl = mapsLink(place, from);
  const straight = distanceM(from, place);
  const marksP = landmarksAlong(from, place);

  try {
    const url = `${ROUTING_URL()}/${from.lng.toFixed(6)},${from.lat.toFixed(6)};${place.lng.toFixed(6)},${place.lat.toFixed(6)}?steps=true&overview=full&geometries=geojson`;
    const res = await httpFetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "EchoBot/0.1" } });
    const data = (await res.json()) as OsrmResponse;
    const route = data.routes?.[0];
    if (data.code !== "Ok" || !route) throw new Error(`routing ${data.code}`);
    const marks = await marksP;
    const steps: string[] = [];
    for (const s of route.legs.flatMap((l) => l.steps)) {
      const at = { lat: s.maneuver.location[1], lng: s.maneuver.location[0] };
      const near = nearestMark(at, marks, place.name);
      const by = near ? ` at ${near.name}` : "";
      const walk = s.distance >= 15 ? `, walk ${formatDistance(s.distance)}` : "";
      switch (s.maneuver.type) {
        case "depart":
          steps.push(
            `Start${near ? ` by ${near.name}` : ""} and head ${compass(s.maneuver.bearing_after ?? bearing(from, place))}${s.name ? ` along ${s.name}` : ""}${walk}.`,
          );
          break;
        case "arrive":
          break;
        case "roundabout":
        case "rotary":
          steps.push(`At the roundabout${by}, take your exit${street(s.name)}${walk}.`);
          break;
        case "new name":
        case "continue":
          if (s.distance >= 15) steps.push(`Keep going${s.name ? ` along ${s.name}` : ""}${by}${walk}.`);
          break;
        default:
          steps.push(`${turnWord(s.maneuver.modifier)}${by}${street(s.name)}${walk}.`);
      }
    }
    steps.push(arrival(place));
    return {
      steps: merge(steps),
      distance: route.distance,
      minutes: walkMinutes(route.distance),
      line: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      mapsUrl,
      routed: true,
    };
  } catch (err) {
    console.error(`[find] routing failed: ${err instanceof Error ? err.message : err}`);
    const marks = await marksP;
    const near = nearestMark(place, marks, place.name, 80);
    const steps = [
      `It's about ${formatDistance(straight)} ${compass(bearing(from, place))} of you${near ? `, near ${near.name}` : ""}.`,
      arrival(place),
      "I couldn't get a walking route right now, so use the map link for turn-by-turn.",
    ];
    return {
      steps,
      distance: straight,
      minutes: walkMinutes(straight * 1.3),
      line: [
        [from.lat, from.lng],
        [place.lat, place.lng],
      ],
      mapsUrl,
      routed: false,
    };
  }
}

function arrival(place: Place): string {
  const hints = [place.landmark, place.lastMile].filter(Boolean).join("; ");
  return `${place.name} is there${hints ? ` (${hints})` : ""}.`;
}

/** Drop repeated "Keep going" lines that add nothing. */
function merge(steps: string[]): string[] {
  return steps.filter((s, i) => !(s.startsWith("Keep going") && steps[i - 1]?.startsWith("Keep going")));
}
