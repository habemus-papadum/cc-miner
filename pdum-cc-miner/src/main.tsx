/**
 * ── START HERE ────────────────────────────────────────────────────────────────
 *
 * This is an INTERACTIVE WEB PAGE wired into a live coding loop — not a static
 * site. Two processes are (or should be) running:
 *
 *   terminal 1:  npx aiui claude   Claude Code with the aiui channel + browser
 *   terminal 2:  npm run dev       this app, served by Vite via `aiui vite`
 *
 * On the page, activate the intent client (⌘B), then SAY or
 * type what you want — "make this golden", "turn this into a tide chart
 * for my harbor", anything. Your words (plus screenshots and the source
 * locations of what you pointed at) land in the Claude session as a prompt,
 * and the agent edits this very code while you watch it hot-reload.
 *
 * There is deliberately almost nothing in this file. The aiui() plugin
 * (vite.config.ts — the entire integration) stamps the source locations the
 * intent client's attribution reads; the app splits along HMR lines:
 *
 *   src/model/store.ts   durable roots — parameters survive hot edits
 *   src/model/graph.ts   the cell graph (dataflow) + the agent tools
 *   src/ui/              components — freely hot-swappable
 *   src/page.tsx         the app as a mountable SitePage (both hosts' entry)
 *   src/index.ts         the library barrel (what siblings import)
 *   src/card.tsx         the app's live landing card (a gallery's preview)
 *
 * Everything you can see is scenery, built to be rebuilt. Start talking.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { render } from "@solidjs/web";
import { HOST } from "./host";
import { page } from "./page";

// The only place the shell shows up in the renderer: a title suffix, so the two
// dev servers are tellable apart when both are open. Everything below this line
// is identical in a tab and in an Electron window — that is the invariant the
// two Vite configs exist to preserve.
document.title = HOST === "electron" ? `${page.title} · electron` : page.title;
page.activate?.();
render(() => <page.App />, document.getElementById("root") as HTMLElement);
