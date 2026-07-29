import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vitest/config";

// Vitest prefers THIS file over vite.config.ts, so tests run a leaner plugin
// set: locator-only aiui(), no solid() (the full pipeline belongs to the dev
// server, not the test runner). The tests here are headless dataflow tests — playbook layers 1 and 2: pure math
// and cells, no DOM rendering. Three settings matter:
//
//  - environment jsdom: `durable()` keeps its registry on `window`, so cell
//    graphs need a window even without rendering.
//  - resolve.conditions + inline: Solid must resolve as ONE shared browser/dev
//    build under Vitest, or effects silently observe a different reactive
//    instance than the one your cells write to (the full story lives with
//    solidTestDeps in @habemus-papadum/aiui-build-config).
//  - passWithNoTests: a freshly reset blank app has no tests yet; `npm test`
//    should still be green until your first cell brings its first test.
export default defineConfig({
  // The aiui compiler must run under Vitest too: control()/cell() names,
  // locations, and descriptions are compiler-injected, and tests exercise the
  // same inference the app gets (the locator is all it runs).
  plugins: [aiui({ locator: true })],
  resolve: {
    conditions: ["browser", "development", "import", "module", "default"],
  },
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    server: { deps: { inline: [/solid-js/, /@solidjs\//, /@habemus-papadum\//] } },
  },
});
