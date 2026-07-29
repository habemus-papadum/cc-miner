import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  isSourceMode,
  type ModeStore,
  modeFromSearch,
  persistMode,
  resolveMode,
} from "./source-mode";

const store = (
  initial: Record<string, string> = {},
): ModeStore & { data: Record<string, string> } => {
  const data = { ...initial };
  return {
    data,
    get: (k) => data[k] ?? null,
    set: (k, v) => {
      data[k] = v;
    },
  };
};

describe("resolveMode", () => {
  it("defaults to local, because that needs no server running", () => {
    expect(DEFAULT_MODE).toBe("local");
    expect(resolveMode("", null)).toBe("local");
    expect(resolveMode("", store())).toBe("local");
  });

  it("lets the URL pin a mode, outranking what was persisted", () => {
    const s = store({ "pdum-cc-miner.sourceMode": "local" });
    expect(resolveMode("?source=host", s)).toBe("host");
  });

  it("remembers the operator's last choice", () => {
    const s = store();
    persistMode("host", s);
    expect(resolveMode("", s)).toBe("host");
    persistMode("local", s);
    expect(resolveMode("", s)).toBe("local");
  });

  it("ignores nonsense rather than throwing or half-applying it", () => {
    expect(resolveMode("?source=s3", store())).toBe("local");
    expect(resolveMode("?source=", store())).toBe("local");
    expect(resolveMode("", store({ "pdum-cc-miner.sourceMode": "banana" }))).toBe("local");
  });

  it("survives a store that is absent entirely", () => {
    expect(resolveMode("?source=host", null)).toBe("host");
    expect(() => persistMode("host", null)).not.toThrow();
  });

  it("never infers a mode from anything but the declaration", () => {
    // The guard for this file's whole premise: resolveMode takes no argument
    // describing what is *running*, so it cannot depend on availability.
    expect(resolveMode.length).toBe(2);
  });
});

describe("modeFromSearch", () => {
  it("reads only the source parameter", () => {
    expect(modeFromSearch("?source=host&other=1")).toBe("host");
    expect(modeFromSearch("?mode=host")).toBeNull();
  });
});

describe("isSourceMode", () => {
  it("accepts exactly the two modes", () => {
    expect(isSourceMode("local")).toBe(true);
    expect(isSourceMode("host")).toBe(true);
    for (const v of ["Local", "HOST", "", null, undefined, 0, {}]) {
      expect(isSourceMode(v)).toBe(false);
    }
  });
});
