// Just enough of the OpenStreetMap opening_hours format to answer "open now?"
// for the common cases ("24/7", "Mo-Fr 08:00-18:00; Sa 09:00-14:00").
// Anything we can't read returns null (unknown), never a guess.

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

type Rule = { days: Set<number>; ranges: [number, number][] | "off" };

function parseDays(spec: string): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [a, b] = part.trim().split("-");
    const i = DAYS.indexOf(a);
    if (i < 0) return null;
    if (!b) {
      out.add(i);
      continue;
    }
    const j = DAYS.indexOf(b);
    if (j < 0) return null;
    for (let k = i; ; k = (k + 1) % 7) {
      out.add(k);
      if (k === j) break;
    }
  }
  return out;
}

function toMin(hhmm: string): number | null {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parse(spec: string): Rule[] | "always" | null {
  const s = spec.trim();
  if (!s) return null;
  if (s === "24/7") return "always";
  const rules: Rule[] = [];
  for (const raw of s.split(";")) {
    const part = raw.trim();
    if (!part || /^PH\b/.test(part)) continue;
    const m = part.match(/^([A-Za-z,\- ]+?)?\s*((?:\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:\s*,\s*)?)+|off|closed)$/);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1].replace(/\s+/g, "")) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    if (m[2] === "off" || m[2] === "closed") {
      rules.push({ days, ranges: "off" });
      continue;
    }
    const ranges: [number, number][] = [];
    for (const r of m[2].split(",")) {
      const [a, b] = r.trim().split("-");
      const from = toMin(a);
      const to = toMin(b);
      if (from === null || to === null) return null;
      ranges.push([from, to]);
    }
    rules.push({ days, ranges });
  }
  return rules.length ? rules : null;
}

/** Day index (Mo=0) and minutes since midnight in the given time zone. */
function localNow(now: Date, timeZone: string): { day: number; min: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { day, min: Number(get("hour")) * 60 + Number(get("minute")) };
}

export type OpenState = { open: boolean | null; today: string | null };

export function openState(spec: string | null | undefined, timeZone: string, now = new Date()): OpenState {
  if (!spec) return { open: null, today: null };
  const rules = parse(spec);
  if (!rules) return { open: null, today: null };
  if (rules === "always") return { open: true, today: "Open 24 hours" };
  const { day, min } = localNow(now, timeZone);
  const prev = (day + 6) % 7;
  // Later rules override earlier ones for the same day, as in the OSM spec.
  const todays = rules.filter((r) => r.days.has(day)).pop();
  const yesterdays = rules.filter((r) => r.days.has(prev)).pop();

  // A range like 18:00-02:00 from yesterday may still be running.
  if (yesterdays && yesterdays.ranges !== "off") {
    for (const [a, b] of yesterdays.ranges) if (b < a && min < b) return { open: true, today: describe(todays) };
  }
  if (!todays) return { open: false, today: "Closed today" };
  if (todays.ranges === "off") return { open: false, today: "Closed today" };
  const open = todays.ranges.some(([a, b]) => (b > a ? min >= a && min < b : min >= a || min < b));
  return { open, today: describe(todays) };
}

function fmt(m: number) {
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function describe(rule: Rule | undefined): string | null {
  if (!rule) return null;
  if (rule.ranges === "off") return "Closed today";
  return `Today ${rule.ranges.map(([a, b]) => `${fmt(a)}-${fmt(b)}`).join(", ")}`;
}
