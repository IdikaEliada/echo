"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { speak, stopSpeaking, useVoice } from "./use-voice";

// Leaflet touches window on import, so the map view loads in the browser only.
const FindView = dynamic(() => import("./find"), { ssr: false });

type Mode = "assistant" | "mirror" | "persona" | "find";
type Debug = { facts: string[]; styleTraits: string[]; styleExamples: string[]; mode: Mode; remembered?: string[] };
type Msg = { role: "user" | "assistant"; content: string; debug?: Debug; error?: boolean };
type Me = {
  user: string;
  linked: boolean;
  mock: boolean;
  bot: string | null;
  memories: { facts: number; style: number; personas: number; places?: number };
};
type Persona = { slug: string; name: string; memories: number };

const HISTORY_KEY = "wb_history_v1";

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

async function fetchStatus(): Promise<{ me?: Me; personas?: Persona[] }> {
  const [me, personas] = await Promise.allSettled([
    fetch("/api/me").then((r) => r.json() as Promise<Me>),
    fetch("/api/personas").then((r) => r.json() as Promise<{ personas?: Persona[] }>),
  ]);
  return {
    me: me.status === "fulfilled" ? me.value : undefined,
    personas: personas.status === "fulfilled" ? (personas.value.personas ?? []) : undefined,
  };
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>(() => load<Msg[]>(HISTORY_KEY, []));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>(() => load<Mode>("wb_mode", "assistant"));
  const [strength, setStrength] = useState(() => load<number>("wb_strength", 70));
  const [persona, setPersona] = useState<string>(() => load<string>("wb_persona", ""));
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [lastDebug, setLastDebug] = useState<Debug | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [showDebug, setShowDebug] = useState(true);
  const [mobilePanel, setMobilePanel] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshMe = useCallback(() => {
    fetchStatus().then(({ me, personas }) => {
      if (me) setMe(me);
      if (personas) setPersonas(personas);
    });
  }, []);

  useEffect(refreshMe, [refreshMe]);

  useEffect(() => save(HISTORY_KEY, messages.slice(-60)), [messages]);
  useEffect(() => save("wb_mode", mode), [mode]);
  useEffect(() => save("wb_strength", strength), [strength]);
  useEffect(() => save("wb_persona", persona), [persona]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const voice = useVoice((text) => setInput(text));

  async function send(textArg?: string) {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    if (mode === "persona" && !persona) {
      setShowImport(true);
      return;
    }
    stopSpeaking();
    setInput("");
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history, mode, persona: persona || undefined, strength }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      let debug: Debug | undefined;
      const raw = res.headers.get("x-wb-debug");
      if (raw) {
        try {
          debug = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
        } catch {}
      }
      if (debug) setLastDebug(debug);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let reply = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reply += decoder.decode(value, { stream: true });
        setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: reply, debug }]);
      }
      if (!reply.trim()) throw new Error("The model returned an empty reply.");
      if (autoSpeak) speak(reply);
      // Background memory writes finish a few seconds after the reply.
      setTimeout(refreshMe, 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setMessages((m) => [...m.slice(0, -1), { role: "assistant", content: msg, error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function newSession() {
    stopSpeaking();
    setMessages([]);
    setLastDebug(null);
    refreshMe();
  }

  const listening = voice.status === "listening";
  const activePersona = personas.find((p) => p.slug === persona);

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="sticky top-0 z-[5] flex items-center gap-3 bg-surface px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-[12px] bg-ink text-[15px] font-semibold text-white">E</div>
          <div>
            <div className="text-[16px] font-semibold leading-tight text-ink">EchoBot</div>
            <div className="text-[12px] text-muted">memory on Walrus {me?.mock ? "· mock mode" : "· mainnet"}</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 text-sm">
          {me && (
            <span className="hidden rounded-[12px] border border-border px-2 py-1 text-[12px] text-foreground sm:inline">
              {me.memories.facts} facts · {me.memories.style} style · {me.memories.places ?? 0} places · {me.memories.personas} persona
            </span>
          )}
          {me?.bot && (
            <a
              href={`https://t.me/${me.bot}`}
              target="_blank"
              rel="noreferrer"
              className="hidden rounded-full border border-iron bg-surface px-4 py-2 text-[14px] text-iron hover:bg-surface-2 md:inline"
            >
              Chat on Telegram ↗
            </a>
          )}
          <button
            onClick={() => setShowLink(true)}
            className="whitespace-nowrap rounded-[14px] bg-surface-2 px-3 py-2 text-[14px] text-foreground hover:bg-background sm:px-4"
            title={me?.user}
          >
            {me?.linked ? "Linked ✓" : <>Link<span className="hidden sm:inline"> Telegram</span></>}
          </button>
          <button onClick={newSession} className="btn-primary whitespace-nowrap px-3 py-2 text-[14px] sm:px-4">
            New<span className="hidden sm:inline"> session</span>
          </button>
        </div>
      </header>

      {/* Mode bar */}
      <div className="flex flex-wrap items-center gap-2 border-y border-border bg-surface px-4 py-2 text-[14px]">
        {(
          [
            ["assistant", "Assistant"],
            ["mirror", "Mirror me"],
            ["persona", "Persona"],
            ["find", "Find nearby"],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-full px-4 py-1.5 ${mode === m ? "bg-ink text-white" : "bg-surface-2 text-iron hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
        {mode === "mirror" && (
          <label className="ml-2 flex items-center gap-2 text-muted">
            voice match
            <input
              type="range"
              min={0}
              max={100}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              className="accent-[var(--ink)]"
            />
            <span className="w-8 tabular-nums">{strength}%</span>
          </label>
        )}
        {mode === "persona" && (
          <>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="rounded-[14px] border border-border bg-surface px-3 py-1.5"
            >
              <option value="">Choose persona…</option>
              {personas.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name} ({p.memories})
                </option>
              ))}
            </select>
            <button onClick={() => setShowImport(true)} className="rounded-[14px] border border-border px-3 py-1.5 hover:bg-surface-2">
              Import chat…
            </button>
          </>
        )}
        {mode !== "find" && (
          <label className="ml-auto flex items-center gap-2 text-muted">
            <input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} className="accent-[var(--ink)]" />
            speak replies
          </label>
        )}
        <button onClick={() => setMobilePanel(true)} className={`text-muted hover:text-foreground lg:hidden ${mode === "find" ? "ml-auto" : ""}`}>
          memory
        </button>
        <button
          onClick={() => setShowDebug((v) => !v)}
          className={`hidden text-muted hover:text-foreground lg:inline ${mode === "find" ? "ml-auto" : ""}`}
        >
          {showDebug ? "hide" : "show"} memory panel
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {mode === "find" ? (
          <main className="flex min-w-0 flex-1 flex-col">
            <FindView
              onMemory={(remembered) => {
                setLastDebug({ facts: [], styleTraits: [], styleExamples: [], mode: "find", remembered });
                setTimeout(refreshMe, 4000);
              }}
            />
          </main>
        ) : (
        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
            {messages.length === 0 && <Empty mode={mode} personaName={activePersona?.name} onPick={(t) => send(t)} />}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`group max-w-[85%] whitespace-pre-wrap rounded-[22px] px-4 py-2.5 text-[15px] leading-relaxed ${
                    m.role === "user"
                      ? "bg-ink text-white"
                      : m.error
                        ? "border border-danger/30 bg-danger/5 text-danger"
                        : "border border-border bg-surface"
                  }`}
                >
                  {m.content || <span className="animate-pulse text-muted">thinking…</span>}
                  {m.role === "assistant" && m.content && !m.error && (
                    <div className="mt-1 flex gap-3 text-xs text-muted transition sm:opacity-0 sm:group-hover:opacity-100">
                      <button onClick={() => speak(m.content)}>🔊 speak</button>
                      {m.debug && (
                        <span>
                          {m.debug.facts.length} memories · {m.debug.styleTraits.length + m.debug.styleExamples.length} style
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Composer */}
          <div className="border-t border-border bg-surface p-3">
            {voice.error && (
              <div className="mb-2 flex items-center justify-between rounded-[14px] bg-danger/5 px-3 py-2 text-sm text-danger">
                {voice.error}
                <button onClick={voice.clearError}>✕</button>
              </div>
            )}
            {(listening || voice.status === "transcribing") && (
              <div className="mb-2 flex items-center gap-2 text-sm text-muted">
                <span className="size-2 animate-pulse rounded-full bg-danger" />
                {!listening
                  ? "Transcribing…"
                  : voice.engine === "browser"
                    ? "Listening… your words appear below. Tap ■ when done."
                    : "Recording… tap ■ when done and I'll transcribe it."}
              </div>
            )}
            <div className="flex items-end gap-2">
              <button
                onClick={listening ? voice.stop : voice.start}
                disabled={!voice.supported || voice.status === "transcribing" || busy}
                className={`grid size-11 shrink-0 place-items-center rounded-full text-lg ${
                  listening ? "recording bg-danger text-white" : "border border-border bg-surface-2 hover:border-border-strong"
                } disabled:opacity-40`}
                title={voice.supported ? "Voice input" : "Voice not supported in this browser"}
                aria-label={listening ? "Stop recording" : "Start recording"}
              >
                {listening ? "■" : "🎙"}
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder={
                  mode === "persona" && activePersona ? `Message ${activePersona.name}…` : "Tell me something about you…"
                }
                className="max-h-40 min-h-11 flex-1 resize-none rounded-[14px] border border-border bg-surface px-4 py-2.5 outline-none placeholder:text-faint focus:border-border-strong"
              />
              <button
                onClick={() => send()}
                disabled={busy || !input.trim()}
                className="btn-primary h-11 shrink-0 px-5 text-[14px]"
              >
                Send
              </button>
            </div>
          </div>
        </main>
        )}

        {showDebug && (
          <MemoryPanel debug={lastDebug} me={me} className="hidden w-80 shrink-0 border-l border-border bg-surface lg:block" />
        )}
      </div>

      {mobilePanel && (
        <div className="fixed inset-0 z-[1100] flex justify-end bg-black/40 lg:hidden" onClick={() => setMobilePanel(false)}>
          <div className="relative h-full w-[85%] max-w-sm bg-surface" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setMobilePanel(false)}
              className="absolute top-3 right-3 text-muted hover:text-foreground"
              aria-label="Close memory panel"
            >
              ✕
            </button>
            <MemoryPanel debug={lastDebug} me={me} className="h-full" />
          </div>
        </div>
      )}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onDone={(slug) => {
            setShowImport(false);
            setMode("persona");
            setPersona(slug);
            refreshMe();
          }}
        />
      )}
      {showLink && (
        <LinkDialog
          me={me}
          onClose={() => setShowLink(false)}
          onDone={() => {
            setShowLink(false);
            newSession();
          }}
        />
      )}
    </div>
  );
}

function Empty({ mode, personaName, onPick }: { mode: Mode; personaName?: string; onPick: (t: string) => void }) {
  const prompts =
    mode === "persona"
      ? ["hey what are you up to?", "miss me?", "what should we do this weekend"]
      : mode === "mirror"
        ? ["yo! what's good", "ngl today was wild fr", "what do you know about me?"]
        : [
            "My name is Alex. I'm building a startup called PayFlow. I'm using TypeScript and Next.js.",
            "What is my startup called?",
            "What programming language do I prefer?",
          ];
  return (
    <div className="mx-auto mt-10 max-w-xl text-center">
      <h1 className="text-[40px] font-semibold leading-[1.15] text-ink">
        {mode === "persona" ? (personaName ? `Chat with ${personaName}` : "Import a persona") : "Hey, I remember you."}
      </h1>
      <p className="mt-2 text-muted">
        {mode === "mirror"
          ? "Mirror mode: the more you chat, the more I talk like you. Your style is stored on Walrus."
          : mode === "persona"
            ? "Upload a WhatsApp or Telegram export and I'll reply in that person's voice."
            : "Tell me about yourself, then start a new session. I'll still know — memory lives on Walrus, not in this tab."}
      </p>
      <div className="mt-6 flex flex-col gap-2">
        {prompts.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="rounded-[14px] border border-border bg-surface px-4 py-3 text-left text-[14px] hover:border-border-strong"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MemoryPanel({ debug, me, className }: { debug: Debug | null; me: Me | null; className: string }) {
  return (
    <aside className={`overflow-y-auto p-4 text-sm ${className}`}>
      <h2 className="text-[20px] font-semibold text-ink">Memory panel</h2>
      <p className="mt-1 text-xs text-muted">Only your own memories are shown here.</p>

      {me && (
        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          {(
            [
              ["facts", me.memories.facts],
              ["style", me.memories.style],
              ["places", me.memories.places ?? 0],
              ["persona", me.memories.personas],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded-[14px] border border-border bg-surface-2 p-2">
              <div className="text-[20px] font-semibold tabular-nums text-ink">{v}</div>
              <div className="text-xs text-muted">{k}</div>
            </div>
          ))}
        </div>
      )}

      {debug?.mode === "find" ? (
        <Section
          title={`Used for this search (${debug.remembered?.length ?? 0})`}
          items={debug.remembered}
          empty="Nothing from memory changed this search yet. Pass on a place or rate one, and the next search will use it."
        />
      ) : (
        <Section title={`Recalled facts (${debug?.facts.length ?? 0})`} items={debug?.facts} empty="Send a message to see what gets recalled." />
      )}
      {debug && debug.mode !== "assistant" && debug.mode !== "find" && (
        <>
          <Section title={`Style traits (${debug.styleTraits.length})`} items={debug.styleTraits} empty="No style learned yet." />
          <Section title={`Voice samples (${debug.styleExamples.length})`} items={debug.styleExamples} empty="No samples yet." />
        </>
      )}
    </aside>
  );
}

function Section({ title, items, empty }: { title: string; items?: string[]; empty: string }) {
  return (
    <div className="mt-5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{title}</h3>
      {items?.length ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((t, i) => (
            <li key={i} className="rounded-[12px] border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] leading-relaxed">
              {t}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">{empty}</p>
      )}
    </div>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[1100] grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-[36px] border border-border bg-surface p-7" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[20px] font-semibold text-ink">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (slug: string) => void }) {
  const [raw, setRaw] = useState("");
  const [senders, setSenders] = useState<{ name: string; count: number }[]>([]);
  const [target, setTarget] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: object) {
    const res = await fetch("/api/personas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Request failed");
    return data;
  }

  async function onFile(file: File) {
    setError(null);
    const text = await file.text();
    setRaw(text);
    try {
      const data = await post({ raw: text });
      setSenders(data.senders);
      setTarget(data.senders[0]?.name ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that file.");
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const data = await post({ raw, target, consent });
      onDone(data.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Import a persona" onClose={onClose}>
      <p className="text-sm text-muted">
        WhatsApp: open the chat → ⋮ → More → Export chat → Without media. Telegram Desktop: Export chat history → JSON.
      </p>
      <input
        type="file"
        accept=".txt,.json,text/plain,application/json"
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        className="mt-4 block w-full text-sm file:mr-3 file:rounded-[12px] file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-foreground"
      />
      {senders.length > 0 && (
        <>
          <label className="mt-4 block text-sm">
            Who should I learn to talk like?
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-1 w-full rounded-[14px] border border-border bg-surface px-3 py-2"
            >
              {senders.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} — {s.count} messages
                </option>
              ))}
            </select>
          </label>
          <label className="mt-4 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
            <span>
              {target || "This person"} agreed to have their messages used for an AI persona. The persona is always labeled as AI.
            </span>
          </label>
          <button
            onClick={run}
            disabled={!consent || !target || busy}
            className="btn-primary mt-4 w-full py-2.5 text-[14px]"
          >
            {busy ? "Building persona… (stores samples on Walrus)" : "Create persona"}
          </button>
        </>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

function LinkDialog({ me, onClose, onDone }: { me: Me | null; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function link() {
    setError(null);
    const res = await fetch("/api/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error);
    else onDone();
  }
  return (
    <Dialog title="Link your Telegram" onClose={onClose}>
      <p className="text-sm text-muted">
        {me?.linked
          ? "This browser already uses your Telegram memory. Paste a new code to switch accounts."
          : `Send /link to ${me?.bot ? `@${me.bot}` : "the EchoBot bot"} on Telegram and paste the code here. Web, Telegram and CLI will then share one memory.`}
      </p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="WB-…"
        className="mt-4 w-full rounded-[14px] border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-border-strong"
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <button onClick={link} disabled={!code.trim()} className="btn-primary mt-4 w-full py-2.5 text-[14px]">
        Link
      </button>
    </Dialog>
  );
}
