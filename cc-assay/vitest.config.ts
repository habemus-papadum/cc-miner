import { defineConfig } from "vitest/config";

// Pure node: this package reads files and does arithmetic. No DOM, no Solid,
// no aiui compiler pass — it declares no cells or controls.
export default defineConfig({
  test: { environment: "node", passWithNoTests: true },
});
