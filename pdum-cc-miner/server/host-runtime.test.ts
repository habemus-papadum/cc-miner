/**
 * What `/__duckdb-host` promises the page.
 *
 * This is a contract test, not a unit test for its own sake. The page uses
 * `quackUri` VERBATIM — it deliberately no longer derives an endpoint from
 * `location`, because deriving one is what broke the packaged app: under
 * `app://pdum-cc-miner/`, `quack:${location.host}/quack` became `quack:cc-miner/quack`
 * and the load hung with no request and no error. So the field's presence and
 * shape are the seam, and a seam nobody checks is a seam that drifts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "cc-host-runtime-"));
const file = join(dir, "duckdb-host.json");
process.env.PDUM_CC_MINER_HOST_RUNTIME = file;

// Imported AFTER the env var is set: the module resolves its path once, at load.
const { hostInfo, hostPort, readHostRuntime } = await import("./host-runtime.mjs");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (patch: Record<string, unknown> = {}) =>
  writeFileSync(
    file,
    JSON.stringify({
      port: 60679,
      token: "deadbeef",
      pid: 1234,
      url: "http://127.0.0.1:60679",
      source: { kind: "local", dataDir: "/tmp/corpus" },
      replayBase: "/tmp/corpus/replay",
      manifest: { generatedAt: "2026-07-29" },
      replayIndex: [],
      grains: ["turns", "sessions"],
      missing: [],
      startedAt: "2026-07-29T00:00:00.000Z",
      ...patch,
    }),
  );

describe("hostInfo", () => {
  it("states the endpoint rather than leaving the page to derive one", () => {
    write();
    const info = hostInfo();
    expect(info.ok).toBe(true);
    expect(info.quackUri).toBe("quack:127.0.0.1:60679/quack");
  });

  it("names the IPv4 loopback explicitly", () => {
    // `localhost` can resolve to ::1 first, and quack_serve binds 127.0.0.1
    // only — so the literal, not a name, is the answer.
    write();
    expect(hostInfo().quackUri).not.toContain("localhost");
  });

  it("carries the token and the corpus metadata the page cannot know", () => {
    write();
    const info = hostInfo();
    expect(info.token).toBe("deadbeef");
    expect(info.grains).toEqual(["turns", "sessions"]);
    expect(info.replayBase).toBe("/tmp/corpus/replay");
    expect(info.manifest).toEqual({ generatedAt: "2026-07-29" });
  });

  it("says so, actionably, when no host is running", () => {
    rmSync(file, { force: true });
    const info = hostInfo();
    expect(info.ok).toBe(false);
    expect(info.quackUri).toBeUndefined();
    expect(info.error).toMatch(/pnpm serve/);
  });

  it("treats an unreadable runtime file as absent, not as a crash", () => {
    writeFileSync(file, "{ this is not json");
    expect(readHostRuntime()).toBeNull();
    expect(hostInfo().ok).toBe(false);
  });

  it("picks the port up per call, so a host restart needs no invalidation", () => {
    // Both fields move, because a real restart moves both: `port` is what the
    // host asked for and `url` is what quack bound. Patching only `port` here
    // used to pass by accident — the endpoint came from `port` — and now would
    // assert the stale `url`, which is the bug this pairing exists to prevent.
    write({ port: 1111, url: "http://127.0.0.1:1111" });
    expect(hostInfo().quackUri).toBe("quack:127.0.0.1:1111/quack");
    write({ port: 2222, url: "http://127.0.0.1:2222" });
    expect(hostInfo().quackUri).toBe("quack:127.0.0.1:2222/quack");
  });

  it("advertises what quack BOUND when the two disagree", () => {
    // The real-world failure: the requested port was taken between `freePort()`
    // releasing it and quack claiming it, so quack landed elsewhere. Advertising
    // `port` sends the page to an empty address —
    // `net::ERR_CONNECTION_REFUSED` in a worker, three processes from the cause.
    write({ port: 51373, url: "http://127.0.0.1:51772" });
    expect(hostInfo().quackUri).toBe("quack:127.0.0.1:51772/quack");
  });
});

describe("hostPort — advertise what was BOUND, not what was requested", () => {
  it("prefers quack's own listen_url over the requested port", () => {
    // The bug this exists for: `port` is chosen by binding :0 and closing it, so
    // anything can claim that number before quack does. Advertising the request
    // sends the page to an empty address and the renderer can only say
    // net::ERR_CONNECTION_REFUSED.
    expect(hostPort({ port: 51373, url: "http://127.0.0.1:51772" })).toBe("127.0.0.1:51772");
  });

  it("falls back to the requested port when a runtime file predates `url`", () => {
    expect(hostPort({ port: 51373 })).toBe("127.0.0.1:51373");
  });

  it("falls back rather than throwing on a url it cannot parse", () => {
    expect(hostPort({ port: 51373, url: "not a url" })).toBe("127.0.0.1:51373");
    expect(hostPort({ port: 51373, url: "http://127.0.0.1" })).toBe("127.0.0.1:51373");
  });

  it("always answers 127.0.0.1, never localhost", () => {
    // localhost can resolve ::1 first; quack_serve binds IPv4 loopback only.
    expect(hostPort({ port: 1, url: "http://localhost:4242" })).toBe("127.0.0.1:4242");
  });
});
