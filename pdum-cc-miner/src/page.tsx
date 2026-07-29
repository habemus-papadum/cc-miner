/**
 * page.tsx — this app as a mountable **SitePage**: the one entry both hosts
 * share. `main.tsx` mounts it standalone; a multi-app shell (a gallery of
 * demos, a notebook site) can mount it too, discovering it through the
 * `aiui.sitePage` marker in package.json and this package's `./page` export.
 *
 * Importing this module IS the app's wiring: the graph import builds the cell
 * graph and registers the agent tools (side effects, on first import), and
 * the stylesheet rides along so the page carries its own look into any host.
 * Fill in `activate`/`deactivate` if the app ever runs continuous work (rAF
 * loops) that a shell should park while the page is off-route — the
 * pause-not-destroy lifecycle described on the SitePage type.
 */
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "pdum-cc-miner — an aiui app",
  App,
};
