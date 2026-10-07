"use client";

// Find nearby: a satellite map with labelled pins and your location's accuracy
// circle (like the NIPOST postcode finder), one top pick, and the memory that
// shaped it.

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type Rating = { avg: number; count: number; tags: string[] };
type Pick = {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  phone?: string;
  address?: string;
  landmark?: string;
  lastMile?: string;
  source: "echobot" | "osm";
  distance: number;
  minutes: number;
  direction: string;
  open: boolean | null;
  todayHours: string | null;
  rating?: Rating;
  why: string[];
  mapsUrl: string;
};
type Origin = { lat: number; lng: number; label: string; accuracy?: number; source: string };
export type FindResult =
  | {
      ok: true;
      query: string;
      category: { id: string; label: string };
      origin: Origin;
      picks: Pick[];
      index: number;
      remembered: string[];
      notes: string[];
    }
  | { ok: false; need: string; message: string; remembered: string[] };
type Directions = { steps: string[]; distance: number; minutes: number; line: [number, number][]; mapsUrl: string };
type Fix = { lat: number; lng: number; accuracy: number };

const QUICK = ["Barber", "Food", "Printing", "Laundry", "Tailor", "Pharmacy", "ATM"];

async function api<T>(body: object): Promise<T> {
  const res = await fetch("/api/find", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

function dist(m: number) {
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

export default function FindView({ onMemory }: { onMemory: (lines: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [fix, setFix] = useState<Fix | null>(null);
  const [locating, setLocating] = useState(() => !!navigator.geolocation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FindResult | null>(null);
  const [route, setRoute] = useState<Directions | null>(null);
  const [askWhy, setAskWhy] = useState(false);
  const [rated, setRated] = useState<number | null>(null);
  const [spotName, setSpotName] = useState("");
  const [spotSaved, setSpotSaved] = useState<string | null>(null);

  function requestFix() {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setError("Couldn't get your location. Type a landmark instead, e.g. \"barber near the main gate\".");
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  function locate() {
    if (!navigator.geolocation) {
      setError("This browser can't share your location. Type a landmark instead, e.g. \"barber near the main gate\".");
      return;
    }
    setLocating(true);
    requestFix();
  }

  // Ask for the location once; searches still work with a typed landmark.
  useEffect(() => {
    if (navigator.geolocation) requestFix();
  }, []);

  async function search(text = query) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    setRoute(null);
    setAskWhy(false);
    setRated(null);
    try {
      const r = await api<FindResult>({ action: "search", text: q, location: fix });
      setResult(r);
      onMemory(r.remembered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function next(reason?: string) {
    setBusy(true);
    setAskWhy(false);
    setRoute(null);
    setRated(null);
    try {
      const r = await api<FindResult>({ action: "next", reason });
      setResult(r);
      onMemory(r.remembered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const ok = result?.ok ? result : null;
  const pick = ok ? ok.picks[ok.index] : null;

  async function getDirections() {
    if (!ok || !pick) return;
    setBusy(true);
    try {
      const { id, name, category, lat, lng, landmark, lastMile } = pick;
      setRoute(
        await api<Directions>({
          action: "directions",
          from: { lat: ok.origin.lat, lng: ok.origin.lng },
          place: { id, name, category, lat, lng, landmark, lastMile },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get directions.");
    } finally {
      setBusy(false);
    }
  }

  async function rate(stars: number) {
    if (!pick) return;
    setRated(stars);
    await api({ action: "rate", place: { id: pick.id, name: pick.name }, stars }).catch(() => setRated(null));
  }

  async function saveSpot() {
    const at = ok?.origin.source === "pin" || !ok ? fix : ok.origin;
    if (!at || !spotName.trim()) return;
    await api({ action: "save-spot", label: spotName.trim(), lat: at.lat, lng: at.lng });
    setSpotSaved(spotName.trim());
    setSpotName("");
  }

  const center = ok?.origin ?? fix;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-[1200px] gap-4 p-4 lg:grid-cols-[1.15fr_1fr] lg:gap-6 lg:p-6">
        {/* Map card */}
        <section className="rounded-[36px] border border-border bg-surface p-3 lg:sticky lg:top-4 lg:self-start">
          <MapView center={center} accuracy={ok ? ok.origin.accuracy ?? (ok.origin.source === "pin" ? fix?.accuracy : undefined) : fix?.accuracy} picks={ok?.picks ?? []} index={ok?.index ?? 0} route={route?.line} />
          <div className="px-3 pt-3 pb-2 text-[13px] text-muted">
            {locating
              ? "Pinning down where you are…"
              : fix
                ? `Current location accuracy: ${Math.round(fix.accuracy)} metres`
                : "Location off. Name a landmark in your search."}
            {ok && ok.origin.source !== "pin" && <> · searching around {ok.origin.label}</>}
          </div>
          {!fix && !locating && (
            <button onClick={locate} className="mx-3 mb-2 text-[13px] font-medium text-foreground underline underline-offset-4">
              Use my location
            </button>
          )}
        </section>

        {/* Search + result */}
        <section className="flex flex-col gap-4">
          <div>
            <h1 className="text-[32px] font-semibold leading-[1.15] text-ink lg:text-[40px]">Find it near you.</h1>
            <p className="mt-2 text-muted">
              One trusted pick, real directions, and a memory of what you like. It all lives on Walrus.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
            className="flex gap-2"
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='e.g. "cheap barber open now" or "printing near the main gate"'
              className="min-w-0 flex-1 rounded-[14px] border border-border bg-surface px-4 py-3 text-[15px] outline-none placeholder:text-faint focus:border-border-strong"
            />
            <button disabled={busy || !query.trim()} className="btn-primary shrink-0 px-5 text-[14px]">
              {busy ? "Finding…" : "Find"}
            </button>
          </form>

          <div className="flex flex-wrap gap-2">
            {QUICK.map((q) => (
              <button
                key={q}
                onClick={() => {
                  setQuery(`${q} near me`);
                  void search(`${q} near me`);
                }}
                className="rounded-[12px] border border-border bg-surface px-3 py-1 text-[13px] text-foreground hover:border-border-strong"
              >
                {q}
              </button>
            ))}
          </div>

          {error && <p className="rounded-[14px] border border-danger/20 bg-danger/5 px-4 py-3 text-[14px] text-danger">{error}</p>}

          {result && !result.ok && (
            <div className="rounded-[36px] border border-border bg-surface p-7 text-[15px]">{result.message}</div>
          )}

          {ok && pick && (
            <>
              {ok.remembered.length > 0 && (
                <div className="rounded-[28px] bg-[#18181b] p-6 text-white">
                  <div className="text-[12px] font-medium uppercase tracking-wide text-faint">What I remembered</div>
                  <ul className="mt-3 space-y-2">
                    {ok.remembered.map((r) => (
                      <li key={r} className="flex gap-2 text-[15px] leading-snug">
                        <span aria-hidden>→</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <article className="rounded-[36px] border border-border bg-surface p-7">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-[12px] bg-ember px-2 py-1 text-[12px] font-medium text-white">
                    {ok.index === 0 ? "Top pick" : `Option ${ok.index + 1}`}
                  </span>
                  <span className="rounded-[12px] border border-border px-2 py-1 text-[12px]">{ok.category.label}</span>
                  {pick.source === "echobot" && (
                    <span className="rounded-[12px] bg-iron px-2 py-1 text-[12px] text-[#fafafa]">Checked in person</span>
                  )}
                </div>
                <h2 className="mt-4 text-[32px] font-semibold leading-tight text-ink">{pick.name}</h2>
                <p className="mt-1 text-[15px] text-iron">
                  {dist(pick.distance)} {pick.direction} · about {pick.minutes} min walk ·{" "}
                  <span className={pick.open === false ? "text-danger" : ""}>
                    {pick.open === true ? "Open now" : pick.open === false ? "Closed now" : "Hours unknown"}
                  </span>
                  {pick.todayHours && <> · {pick.todayHours}</>}
                </p>
                <dl className="mt-4 space-y-1 text-[14px] text-foreground">
                  {pick.landmark && <Row k="Landmark" v={pick.landmark} />}
                  {pick.lastMile && <Row k="Last bit" v={pick.lastMile} />}
                  {pick.address && <Row k="Address" v={pick.address} />}
                  {pick.phone && <Row k="Phone" v={pick.phone} />}
                  <Row
                    k="Rating"
                    v={
                      pick.rating && pick.rating.count >= 3
                        ? `${pick.rating.avg.toFixed(1)}★ on EchoBot (${pick.rating.count} visits)${pick.rating.tags.length ? ` · ${pick.rating.tags.join(", ")}` : ""}`
                        : pick.rating
                          ? `New (${pick.rating.count} of 3 ratings so far)`
                          : "New"
                    }
                  />
                  {pick.why.length > 0 && <Row k="Why" v={pick.why.join("; ")} />}
                  <Row k="Source" v={pick.source === "osm" ? "OpenStreetMap" : "EchoBot"} />
                </dl>

                <button onClick={getDirections} disabled={busy} className="btn-primary mt-6 w-full py-3.5 text-[15px] font-medium">
                  Directions
                </button>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[14px]">
                  <button onClick={() => setAskWhy((v) => !v)} disabled={busy} className="font-medium underline underline-offset-4">
                    Not this one
                  </button>
                  {pick.phone && (
                    <a href={`tel:${pick.phone.replace(/[^+\d]/g, "")}`} className="font-medium underline underline-offset-4">
                      Call
                    </a>
                  )}
                  <a href={pick.mapsUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
                    Open in Google Maps
                  </a>
                </div>
                {askWhy && (
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {[
                      ["Too far", "too far"],
                      ["Closed", "was closed"],
                      ["Too pricey", "too pricey"],
                      ["Bad experience", "bad experience"],
                      ["Just show the next", ""],
                    ].map(([label, reason]) => (
                      <button
                        key={label}
                        onClick={() => next(reason || undefined)}
                        className="rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[13px] hover:border-border-strong"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </article>

              {route && (
                <div className="rounded-[36px] border border-border bg-surface p-7">
                  <h3 className="text-[20px] font-semibold text-ink">
                    Walk {dist(route.distance)}, about {route.minutes} min
                  </h3>
                  <ol className="mt-4 space-y-2.5 text-[15px]">
                    {route.steps.map((s, i) => (
                      <li key={i} className="flex gap-3">
                        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-[12px] font-medium text-iron">
                          {i + 1}
                        </span>
                        {s}
                      </li>
                    ))}
                  </ol>
                  <div className="mt-6 border-t border-border pt-5">
                    <div className="text-[14px] font-medium">Did you go? Rate {pick.name}</div>
                    <div className="mt-2 flex gap-2">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          onClick={() => rate(n)}
                          className={`size-10 rounded-[12px] border text-[16px] ${rated && n <= rated ? "border-ink bg-ink text-white" : "border-border bg-surface hover:border-border-strong"}`}
                          aria-label={`${n} star${n > 1 ? "s" : ""}`}
                        >
                          ★
                        </button>
                      ))}
                    </div>
                    {rated && <p className="mt-2 text-[13px] text-muted">Saved on Walrus. I&apos;ll use it next time, and it counts towards the place&apos;s rating.</p>}
                  </div>
                </div>
              )}

              {ok.picks.length > ok.index + 1 && (
                <div className="rounded-[36px] border border-border bg-surface p-7">
                  <div className="text-[12px] font-medium uppercase tracking-wide text-muted">Also nearby</div>
                  <ul className="mt-3 divide-y divide-border">
                    {ok.picks.slice(ok.index + 1).map((p) => (
                      <li key={p.id} className="flex items-center justify-between py-2.5 text-[14px]">
                        <span className="truncate">{p.name}</span>
                        <span className="shrink-0 pl-3 text-muted">
                          {dist(p.distance)}
                          {p.open === true ? " · open" : p.open === false ? " · closed" : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {ok.notes.map((n) => (
                <p key={n} className="text-[13px] text-muted">
                  {n}
                </p>
              ))}
            </>
          )}

          {(fix || ok) && (
            <div className="rounded-[36px] border border-border bg-surface-2 p-6">
              <div className="text-[14px] font-medium">Save this spot</div>
              <p className="mt-1 text-[13px] text-muted">
                Name where you are (&quot;Hostel B&quot;) and say &quot;food near Hostel B&quot; later, on web, Telegram or CLI.
              </p>
              <div className="mt-3 flex gap-2">
                <input
                  value={spotName}
                  onChange={(e) => setSpotName(e.target.value)}
                  placeholder="Hostel B"
                  maxLength={60}
                  className="min-w-0 flex-1 rounded-[14px] border border-border bg-surface px-3 py-2 text-[14px] outline-none focus:border-border-strong"
                />
                <button onClick={saveSpot} disabled={!spotName.trim()} className="btn-primary px-4 text-[14px]">
                  Save
                </button>
              </div>
              {spotSaved && <p className="mt-2 text-[13px] text-muted">Saved &quot;{spotSaved}&quot; to your memory on Walrus.</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0">{v}</dd>
    </div>
  );
}

function MapView({
  center,
  accuracy,
  picks,
  index,
  route,
}: {
  center: { lat: number; lng: number } | null | undefined;
  accuracy?: number;
  picks: Pick[];
  index: number;
  route?: [number, number][];
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: false, attributionControl: true }).setView([9.06, 7.49], 5);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics | © OpenStreetMap contributors",
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (center) {
      const c: L.LatLngExpression = [center.lat, center.lng];
      if (accuracy) {
        L.circle(c, { radius: accuracy, color: "#1a8cff", weight: 1, fillColor: "#1a8cff", fillOpacity: 0.15 }).addTo(g);
      }
      L.marker(c, { icon: L.divIcon({ className: "eb-chip-wrap", html: '<div class="eb-dot"></div>', iconSize: [14, 14] }) }).addTo(g);
      bounds.push(c);
    }
    picks.forEach((p, i) => {
      if (i < index) return;
      const label = p.name.length > 22 ? `${p.name.slice(0, 21)}…` : p.name;
      const html = `<span class="eb-chip${i === index ? " top" : ""}">${label.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</span>`;
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({ className: "eb-chip-wrap", html, iconSize: [0, 0] }),
        zIndexOffset: i === index ? 1000 : 0,
      }).addTo(g);
      if (i <= index + 3) bounds.push([p.lat, p.lng]);
    });
    if (route?.length) L.polyline(route, { color: "#ffffff", weight: 4, opacity: 0.95, dashArray: "1 8", lineCap: "round" }).addTo(g);
    if (bounds.length > 1) m.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 18 });
    else if (bounds.length === 1) m.setView(bounds[0], 17);
  }, [center, accuracy, picks, index, route]);

  return <div ref={el} className="aspect-[4/5] w-full overflow-hidden rounded-[28px] bg-[#2a2f27] sm:aspect-[4/3]" />;
}
