/**
 * page.tsx — this app as a mountable **SitePage**: the one entry both hosts
 * share. `main.tsx` mounts it standalone, in a browser tab and in the Electron
 * window alike; a multi-app shell (a gallery, a notebook site) could mount it
 * through this package's `./page` export instead.
 *
 * Such a shell discovers pages by convention, through an `aiui.sitePage` block
 * in package.json — which this package does NOT declare, because nothing in
 * this repo is a shell. It is one JSON block away if that changes; the contract
 * is documented on the SitePage type in @habemus-papadum/aiui-viz.
 *
 * Importing this module IS the app's wiring: the graph import builds the cell
 * graph and registers the agent tools (side effects, on first import), and the
 * stylesheet rides along so the page carries its own look into any host.
 * `activate`/`deactivate` are deliberately absent — cc-miner runs no continuous
 * work for a shell to park, and its DuckDB connection costs nothing off-route.
 * Add them if that ever stops being true (pause-not-destroy, per SitePage).
 */
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "pdum-cc-miner — an aiui app",
  App,
};
