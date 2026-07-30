import { describe, expect, it } from "vitest";
import {
  ALL_MODES,
  availableModes,
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
    // The guard for this file's whole premise: resolveMode is handed the URL,
    // the store, and the set of modes this BUILD has — and nothing describing
    // what is currently *running*. It cannot consult a port.
    //
    // `.length` is 2 because `available` is a default parameter and those do
    // not count. Asserting the arity alone would therefore have kept passing
    // when the third argument was added, which is why the real claim is spelled
    // out underneath rather than left to a number.
    expect(resolveMode.length).toBe(2);
    const params = resolveMode
      .toString()
      .slice(resolveMode.toString().indexOf("(") + 1, resolveMode.toString().indexOf(")"));
    expect(params).not.toMatch(/running|port|reachable|alive|probe|fetch/i);
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

describe("availableModes — `local` is dev-only", () => {
  it("offers both in dev", () => {
    expect(availableModes(true)).toEqual(["local", "host"]);
    expect(availableModes(true)).toEqual([...ALL_MODES]);
  });

  it("offers only host in a production build", () => {
    expect(availableModes(false)).toEqual(["host"]);
  });

  it("never offers an empty set — resolveMode's fallback depends on it", () => {
    for (const dev of [true, false]) expect(availableModes(dev).length).toBeGreaterThan(0);
  });
});

describe("resolveMode against the modes a build actually has", () => {
  const PROD = availableModes(false);
  const DEV = availableModes(true);

  it("defaults to host in production, where local does not exist", () => {
    expect(resolveMode("", null, PROD)).toBe("host");
    expect(resolveMode("", store(), PROD)).toBe("host");
  });

  it("still defaults to local in dev", () => {
    expect(resolveMode("", null, DEV)).toBe("local");
  });

  // The case this exists for: a dev session persists `local`, and that value
  // then travels into a packaged build via localStorage or a bookmarked link.
  it("ignores a persisted `local` in production rather than honouring it", () => {
    const s = store({ "pdum-cc-miner.sourceMode": "local" });
    expect(resolveMode("", s, PROD)).toBe("host");
    expect(resolveMode("", s, DEV)).toBe("local");
  });

  it("ignores `?source=local` in production, exactly like a misspelling", () => {
    expect(resolveMode("?source=local", null, PROD)).toBe("host");
    expect(resolveMode("?source=nonsense", null, PROD)).toBe("host");
    expect(resolveMode("?source=local", null, DEV)).toBe("local");
  });

  it("an unavailable URL value falls through to storage, not straight to the default", () => {
    // Precedence has to survive the filter: URL is skipped because `local` is
    // absent here, so the STORED choice gets its turn before the default.
    const s = store({ "pdum-cc-miner.sourceMode": "host" });
    expect(resolveMode("?source=local", s, PROD)).toBe("host");
  });

  it("host is honoured everywhere, since every build has it", () => {
    for (const available of [DEV, PROD]) {
      expect(resolveMode("?source=host", null, available)).toBe("host");
      expect(resolveMode("", store({ "pdum-cc-miner.sourceMode": "host" }), available)).toBe(
        "host",
      );
    }
  });

  it("defaults to ALL_MODES when the caller says nothing, so old callers are unchanged", () => {
    expect(resolveMode("", null)).toBe(DEFAULT_MODE);
  });
});
