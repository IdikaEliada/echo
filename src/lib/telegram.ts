// Telegram bot. The same bot runs two ways:
//   - webhook in production (src/app/api/telegram/route.ts)
//   - long polling locally (npm run telegram)
//
// Everything is stateless across server instances: long-term memory, the
// chosen mode and imported personas all live in Walrus Memory. Only the
// short-term chat history is kept in process memory.

import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { respond, personaName, type ChatTurn, type Mode } from "./brain";
import { env } from "./env";
import {
  currentPick,
  directions,
  findNearby,
  formatResult,
  looksLikeFind,
  nextPick,
  saveSpot,
  saveVisit,
  type FindResult,
} from "./find";
import { formatDistance, type LatLng } from "./find/geo";
import { httpFetch } from "./http";
import { makeLinkCode } from "./identity";
import { ns, recall, remember, userKey, userNamespaces } from "./memory";
import { importPersona, listPersonas, parseChat, senders } from "./persona";
import { rateLimit } from "./rate-limit";
import { transcribe } from "./voice/stt";

type TgMode = Mode | "find";
type Session = { mode: TgMode; persona?: string; history: ChatTurn[]; location?: LatLng & { accuracy?: number }; pendingFind?: string };
type Schedule = (task: () => Promise<unknown>) => void;

const g = globalThis as unknown as { __ebTgSessions?: Map<number, Session> };
const sessions = (g.__ebTgSessions ??= new Map());

const user = (ctx: Context) => userKey("tg", ctx.from!.id);

/** Load the session, restoring the saved mode from Walrus after a cold start. */
async function session(ctx: Context): Promise<Session> {
  const id = ctx.from!.id;
  let s = sessions.get(id);
  if (s) return s;
  s = { mode: "assistant", history: [] };
  const [saved] = await recall(ns.settings(user(ctx)), "telegram mode setting", 1, { sort: "recent" });
  const m = saved?.text.match(/^\[settings\] mode=(assistant|mirror|persona|find)(?: persona=(\S+))?/);
  if (m) {
    s.mode = m[1] as TgMode;
    s.persona = m[2];
  }
  sessions.set(id, s);
  return s;
}

async function setMode(ctx: Context, mode: TgMode, persona?: string) {
  const s = await session(ctx);
  s.mode = mode;
  s.persona = persona;
  s.history = [];
  await remember(ns.settings(user(ctx)), `[settings] mode=${mode}${persona ? ` persona=${persona}` : ""}`);
}

const HELP = [
  "I'm EchoBot: an assistant with memory stored on Walrus.",
  "Tell me about yourself and I'll remember it, even in a brand-new chat.",
  "",
  "Modes",
  "/assistant: normal assistant",
  "/mirror: I learn how you text and start sounding like you",
  "/personas: personas you've imported",
  "/talkto <name>: chat with a persona",
  "/find: find places near you (barber, food, printing, laundry…)",
  "",
  "Find nearby",
  "Share your location (📎 → Location) or name a landmark: \"printing near the main gate\".",
  "I remember your spots, the places you passed on and how your visits went.",
  "/savespot <name>: save your last shared location, e.g. /savespot Hostel B",
  "",
  "Persona import: send me a WhatsApp export (.txt) or Telegram export (result.json) and pick who to learn from.",
  "",
  "Other",
  "/new: fresh conversation (I still remember you)",
  "/memories: what I've stored for you",
  "/link: share one memory with the web app and CLI",
  "",
  "Voice notes work too 🎙",
].join("\n");

export function createBot(schedule: Schedule) {
  if (!env.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  const bot = new Bot(env.telegram.token);

  // Private chats only: in groups every member would share one context.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      if (ctx.message?.text?.startsWith("/start")) {
        await ctx.reply("I only work in private chats. Message me directly!");
      }
      return;
    }
    if (!ctx.from) return;
    await next();
  });

  bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

  bot.command("mirror", async (ctx) => {
    await setMode(ctx, "mirror");
    await ctx.reply("Mirror mode on 🪞 The more you chat, the more I sound like you.");
  });

  bot.command(["assistant", "stop"], async (ctx) => {
    await setMode(ctx, "assistant");
    await ctx.reply("Back to normal assistant mode.");
  });

  bot.command("new", async (ctx) => {
    (await session(ctx)).history = [];
    await ctx.reply("Fresh conversation started. Long-term memory is still on Walrus, so ask me what I remember.");
  });

  bot.command("personas", async (ctx) => {
    const list = await listPersonas(user(ctx));
    if (!list.length) {
      return ctx.reply("No personas yet. Send me a WhatsApp (.txt) or Telegram (result.json) chat export to create one.");
    }
    const kb = new InlineKeyboard();
    list.slice(0, 10).forEach((p) => kb.text(`Talk to ${personaName(p.slug)}`, `talk:${p.slug}`).row());
    return ctx.reply("Your personas:", { reply_markup: kb });
  });

  bot.command("talkto", async (ctx) => {
    const arg = ctx.match.trim().toLowerCase();
    const list = await listPersonas(user(ctx));
    const hit = list.find((p) => p.slug === arg || personaName(p.slug).toLowerCase() === arg) ?? (list.length === 1 && !arg ? list[0] : undefined);
    if (!hit) return ctx.reply("Persona not found. Try /personas.");
    await setMode(ctx, "persona", hit.slug);
    await ctx.reply(`Now chatting with ${personaName(hit.slug)} (AI persona). /stop to exit.`);
  });

  bot.callbackQuery(/^talk:(.+)$/, async (ctx) => {
    const slug = ctx.match[1];
    await ctx.answerCallbackQuery();
    const list = await listPersonas(user(ctx));
    if (!list.some((p) => p.slug === slug)) return ctx.reply("That persona no longer exists.");
    await setMode(ctx, "persona", slug);
    await ctx.reply(`Now chatting with ${personaName(slug)} (AI persona). Say hi! /stop to exit.`);
  });

  // ---- Find nearby ----

  bot.command("find", async (ctx) => {
    const q = ctx.match.trim();
    if (q) return findAndReply(ctx, q);
    await setMode(ctx, "find");
    await ctx.reply(
      "Find mode on 📍 Tell me what you need (\"cheap barber open now\", \"printing near the main gate\"). Share your location with the button below, or name a landmark. /assistant to exit.",
      { reply_markup: locationKeyboard() },
    );
  });

  bot.command("savespot", async (ctx) => {
    const label = ctx.match.trim().slice(0, 60);
    const s = await session(ctx);
    if (!label) return ctx.reply("Give it a name, e.g. /savespot Hostel B");
    if (!s.location) return ctx.reply("Share your location first (📎 → Location), then send /savespot again.", { reply_markup: locationKeyboard() });
    await saveSpot(user(ctx), { label, ...s.location });
    await ctx.reply(`Saved "${label}" to your memory on Walrus. Say "barber near ${label}" any time, on any channel.`);
  });

  bot.on("message:location", async (ctx) => {
    const s = await session(ctx);
    const { latitude, longitude, horizontal_accuracy } = ctx.message.location;
    s.location = { lat: latitude, lng: longitude, accuracy: horizontal_accuracy };
    const pending = s.pendingFind;
    s.pendingFind = undefined;
    if (pending) return findAndReply(ctx, pending);
    await ctx.reply(
      `Got your location${horizontal_accuracy ? ` (accurate to about ${Math.round(horizontal_accuracy)} m)` : ""}. What are you looking for? Tip: /savespot <name> remembers this place.`,
      { reply_markup: { remove_keyboard: true } },
    );
  });

  bot.callbackQuery("f:next", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Why not this one? I'll remember it.", {
      reply_markup: new InlineKeyboard()
        .text("Too far", "f:nx:too far")
        .text("Closed", "f:nx:was closed")
        .row()
        .text("Too pricey", "f:nx:too pricey")
        .text("Just show the next", "f:nx:"),
    });
  });

  bot.callbackQuery(/^f:nx:(.*)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
    await sendFind(ctx, await nextPick(user(ctx), ctx.match[1] || undefined));
  });

  bot.callbackQuery("f:dir", async (ctx) => {
    await ctx.answerCallbackQuery();
    const cur = currentPick(user(ctx));
    if (!cur) return ctx.reply("I lost track of that search. Ask me again and I'll pick it up.");
    await ctx.replyWithChatAction("typing");
    const d = await directions(cur.origin, cur.pick);
    await ctx.reply(
      [`Walking to ${cur.pick.name}: ${formatDistance(d.distance)}, about ${d.minutes} min`, "", ...d.steps.map((x, i) => `${i + 1}. ${x}`)].join("\n"),
      {
        reply_markup: new InlineKeyboard().url("Open in Google Maps", d.mapsUrl).row().text("I went there: rate it", "f:rate"),
      },
    );
  });

  bot.callbackQuery("f:rate", async (ctx) => {
    await ctx.answerCallbackQuery();
    const cur = currentPick(user(ctx));
    if (!cur) return ctx.reply("I lost track of that place. Ask me again and I'll pick it up.");
    const kb = new InlineKeyboard();
    [1, 2, 3, 4, 5].forEach((n) => kb.text("★".repeat(n), `f:r:${n}`));
    await ctx.reply(`How was ${cur.pick.name}? Your rating helps the next person.`, { reply_markup: kb });
  });

  bot.callbackQuery(/^f:r:([1-5])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const cur = currentPick(user(ctx));
    if (!cur) return ctx.reply("I lost track of that place. Ask me again and I'll pick it up.");
    await saveVisit(user(ctx), cur.pick, Number(ctx.match[1]));
    await ctx.editMessageText(
      `Thanks! Saved ${ctx.match[1]}★ for ${cur.pick.name} on Walrus. I'll use it next time you search, and it counts towards its EchoBot rating.`,
    );
  });

  bot.command("link", (ctx) =>
    ctx.reply(
      `Paste this code in the web app or CLI within 15 minutes to share one memory across all of them:\n\n${makeLinkCode(ctx.from!.id)}\n\nDon't share it with anyone else.`,
    ),
  );

  bot.command("memories", async (ctx) => {
    const [facts, spaces, s] = await Promise.all([
      recall(ns.facts(user(ctx)), "everything about the user: name, work, projects, preferences, goals", 10),
      userNamespaces(user(ctx)).catch(() => []),
      session(ctx),
    ]);
    const style = spaces.filter((n) => n.name.endsWith("-style")).reduce((a, n) => a + n.memory_count, 0);
    const personas = spaces.filter((n) => n.name.includes("-p-")).length;
    if (!facts.length && !style && !personas) return ctx.reply("Nothing stored yet. Tell me about yourself!");
    return ctx.reply(
      [
        facts.length ? "What I remember about you:" : "No facts about you yet.",
        ...facts.map((f) => `• ${f.text}`),
        "",
        `Style notes: ${style} · Personas: ${personas}`,
        `Current mode: ${s.mode === "persona" && s.persona ? `persona (${personaName(s.persona)})` : s.mode}`,
        "",
        "All of it is encrypted and stored on Walrus.",
      ].join("\n"),
    );
  });

  // ---- Persona import: send a chat export as a file ----
  // The flow is stateless: buttons sit on a reply to the uploaded file, so each
  // step re-reads the file via reply_to_message instead of server state.

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? "";
    if (!/\.(txt|json)$/i.test(name) && !/text\/plain|application\/json/.test(doc.mime_type ?? "")) {
      return ctx.reply("Send a WhatsApp export (.txt, without media) or a Telegram export (result.json) to build a persona.");
    }
    if ((doc.file_size ?? 0) > 4 * 1024 * 1024) return ctx.reply("That file is too big (max 4 MB).");
    const raw = await downloadText(ctx, doc.file_id);
    if (raw === null) return ctx.reply("Couldn't download that file. Try again.");
    const found = senders(parseChat(raw)).slice(0, 8);
    if (!found.length) return ctx.reply("I couldn't find any messages in that file. Is it a chat export?");
    const kb = new InlineKeyboard();
    found.forEach((s, i) => kb.text(`${s.name} (${s.count})`, `imp:${i}`).row());
    return ctx.reply("Who should I learn to talk like?", {
      reply_markup: kb,
      reply_parameters: { message_id: ctx.message.message_id },
    });
  });

  bot.callbackQuery(/^imp:(\d+)$/, async (ctx) => {
    const target = await importTarget(ctx, Number(ctx.match[1]));
    await ctx.answerCallbackQuery();
    if (!target) return ctx.reply("I lost track of that file. Please send it again.");
    await ctx.editMessageText(
      `Before I learn from ${target}: did ${target} agree to have their messages used for an AI persona? It will always be labeled as AI.`,
      { reply_markup: new InlineKeyboard().text("Yes, they agreed", `ok:${ctx.match[1]}`).text("Cancel", "cancel") },
    );
  });

  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Cancelled. Nothing was stored.");
  });

  bot.callbackQuery(/^ok:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const wait = rateLimit(user(ctx), "import");
    if (wait) return ctx.reply(`Too many imports. Try again in ${Math.ceil(wait / 60)} min.`);
    const fileId = ctx.callbackQuery.message?.reply_to_message?.document?.file_id;
    const raw = fileId ? await downloadText(ctx, fileId) : null;
    const target = raw ? senders(parseChat(raw))[Number(ctx.match[1])]?.name : undefined;
    if (!raw || !target) return ctx.reply("I lost track of that file. Please send it again.");
    await ctx.editMessageText(`Studying how ${target} texts and saving it to Walrus… (about 20 seconds)`);
    try {
      const res = await importPersona({ user: user(ctx), raw, target });
      await setMode(ctx, "persona", res.slug);
      await ctx.reply(
        `Done! Learned ${target}'s style from ${res.messages} messages and stored ${res.stored} memories on Walrus.\n\nYou're now chatting with ${personaName(res.slug)} (AI persona). Say hi! /stop to exit.`,
      );
    } catch (err) {
      console.error("[telegram] import failed:", err);
      await ctx.reply(err instanceof Error ? err.message : "Import failed. Try again.");
    }
  });

  // ---- Chat ----

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return ctx.reply("Unknown command. Try /help.");
    const s = await session(ctx);
    if (s.mode === "find" || (s.mode === "assistant" && looksLikeFind(ctx.message.text))) {
      return findAndReply(ctx, ctx.message.text);
    }
    await answer(ctx, ctx.message.text, schedule);
  });

  bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
    const wait = rateLimit(user(ctx), "voice");
    if (wait) return ctx.reply(`Slow down a little. Try again in ${wait}s.`);
    const media = ctx.message.voice ?? ctx.message.audio ?? ctx.message.video_note;
    if (media && "duration" in media && media.duration > 300) return ctx.reply("Voice messages up to 5 minutes, please.");
    await ctx.replyWithChatAction("typing");
    let text: string;
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("no file path");
      const res = await httpFetch(fileUrl(file.file_path));
      text = await transcribe(new Blob([await res.arrayBuffer()]), file.file_path.split("/").pop() ?? "voice.ogg");
    } catch (err) {
      console.error("[telegram] transcription failed:", err);
      return ctx.reply("Sorry, I couldn't make out that voice message. Try again or type it.");
    }
    await ctx.reply(`🎙 “${text}”`);
    const s = await session(ctx);
    if (s.mode === "find" || (s.mode === "assistant" && looksLikeFind(text))) return findAndReply(ctx, text);
    await answer(ctx, text, schedule);
  });

  bot.on("message", (ctx) => ctx.reply("I can read text, voice notes, locations and chat-export files. Try /help."));

  bot.catch((err) => console.error("[telegram] error:", err.error));
  return bot;
}

function fileUrl(path: string) {
  return `https://api.telegram.org/file/bot${env.telegram.token}/${path}`;
}

async function downloadText(ctx: Context, fileId: string): Promise<string | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await httpFetch(fileUrl(file.file_path));
    return res.ok ? await res.text() : null;
  } catch (err) {
    console.error("[telegram] download failed:", err);
    return null;
  }
}

async function importTarget(ctx: Context, index: number): Promise<string | undefined> {
  const fileId = ctx.callbackQuery?.message?.reply_to_message?.document?.file_id;
  const raw = fileId ? await downloadText(ctx, fileId) : null;
  return raw ? senders(parseChat(raw))[index]?.name : undefined;
}

/** Telegram caps messages at 4096 chars. */
function chunks(text: string, size = 4000): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function locationKeyboard() {
  return new Keyboard().requestLocation("📍 Share my location").resized().oneTime();
}

async function findAndReply(ctx: Context, text: string) {
  const wait = rateLimit(user(ctx), "chat");
  if (wait) {
    await ctx.reply(`You're sending messages fast! Give me ${wait}s.`);
    return;
  }
  const s = await session(ctx);
  await ctx.replyWithChatAction("find_location");
  try {
    const result = await findNearby({ user: user(ctx), text: text.slice(0, 500), location: s.location });
    if (!result.ok && result.need === "location") s.pendingFind = text;
    await sendFind(ctx, result);
  } catch (err) {
    console.error("[telegram] find failed:", err);
    await ctx.reply("Something went wrong while searching. Try again in a moment.");
  }
}

async function sendFind(ctx: Context, result: FindResult) {
  if (!result.ok) {
    await ctx.reply(formatResult(result), result.need === "location" ? { reply_markup: locationKeyboard() } : {});
    return;
  }
  const p = result.picks[result.index];
  // A venue message is a tappable map pin in every Telegram client.
  await ctx.replyWithVenue(p.lat, p.lng, p.name, p.address ?? p.landmark ?? `${formatDistance(p.distance)} ${p.direction} of ${result.origin.label}`);
  const kb = new InlineKeyboard().text("Not this one", "f:next").text("Directions", "f:dir").row().url("Open in Google Maps", p.mapsUrl);
  await ctx.reply(formatResult(result), { reply_markup: kb });
}

async function answer(ctx: Context, text: string, schedule: Schedule) {
  const wait = rateLimit(user(ctx), "chat");
  if (wait) {
    await ctx.reply(`You're sending messages fast! Give me ${wait}s.`);
    return;
  }
  const s = await session(ctx);
  await ctx.replyWithChatAction("typing");
  try {
    const { result, afterTurn } = await respond({
      user: user(ctx),
      message: text.slice(0, 4000),
      history: s.history,
      mode: s.mode === "find" ? "assistant" : s.mode,
      persona: s.persona,
      channel: "telegram",
    });
    const reply = (await result.text).trim() || "…";
    s.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    s.history = s.history.slice(-12);
    for (const part of chunks(reply)) await ctx.reply(part);
    schedule(afterTurn);
  } catch (err) {
    console.error("[telegram] respond failed:", err);
    await ctx.reply("Something went wrong on my side. Try again in a moment.");
  }
}
