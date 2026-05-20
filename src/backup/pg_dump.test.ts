import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { gunzipSync } from "zlib";
import { describe, expect, it, vi } from "vitest";
import {
  pgDumpArgs,
  pgDumpToBuffer,
  r2EndpointForAccount,
  r2ObjectKey,
  runBackup,
  type SpawnFn,
} from "./pg_dump.js";

type FakeChild = ReturnType<typeof makeFakeChild>;

function makeFakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout,
    stderr,
    pushStdout(b: Buffer | string) {
      stdout.write(typeof b === "string" ? Buffer.from(b) : b);
    },
    pushStderr(b: string) {
      stderr.write(b);
    },
    finish(code: number) {
      stdout.end();
      stderr.end();
      emitter.emit("exit", code);
    },
    fail(err: Error) {
      emitter.emit("error", err);
    },
  });
}

function fakeSpawnReturning(child: FakeChild): SpawnFn {
  return (() => child) as unknown as SpawnFn;
}

describe("r2ObjectKey", () => {
  it("formats UTC date as home-systems/YYYY-MM-DDTHHMMZ.sql.gz", () => {
    const d = new Date(Date.UTC(2026, 4, 11, 3, 15, 30));
    expect(r2ObjectKey(d)).toBe("home-systems/2026-05-11T0315Z.sql.gz");
  });

  it("pads single-digit months/days/hours/minutes", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 4, 5));
    expect(r2ObjectKey(d)).toBe("home-systems/2026-01-02T0405Z.sql.gz");
  });

  it("respects a custom prefix", () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0));
    expect(r2ObjectKey(d, "scratch")).toBe("scratch/2026-01-01T0000Z.sql.gz");
  });
});

describe("pgDumpArgs", () => {
  it("returns --no-owner --no-privileges --format=plain <url>", () => {
    expect(pgDumpArgs("postgres://u:p@h/db")).toEqual([
      "--no-owner",
      "--no-privileges",
      "--format=plain",
      "postgres://u:p@h/db",
    ]);
  });
});

describe("r2EndpointForAccount", () => {
  it("builds the cloudflarestorage URL from account id", () => {
    expect(r2EndpointForAccount("abc123")).toBe("https://abc123.r2.cloudflarestorage.com");
  });
});

describe("pgDumpToBuffer", () => {
  // Realistic-looking dump payload above the MIN_GZIP_BYTES floor.
  const REAL_DUMP =
    "-- PostgreSQL database dump\n" +
    "SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET client_encoding = 'UTF8';\n" +
    "CREATE TABLE foo (id int PRIMARY KEY, label text);\n" +
    "INSERT INTO foo VALUES (1, 'hello'), (2, 'world');\n";

  it("collects gzipped stdout and resolves on exit 0", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const promise = pgDumpToBuffer("postgres://x", spawnFn);

    child.pushStdout(REAL_DUMP);
    child.finish(0);

    const buf = await promise;
    expect(buf.length).toBeGreaterThan(0);
    expect(gunzipSync(buf).toString()).toBe(REAL_DUMP);
  });

  it("rejects with stderr content when pg_dump exits non-zero", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const promise = pgDumpToBuffer("postgres://bad", spawnFn);

    child.pushStderr("connection refused");
    child.finish(1);

    await expect(promise).rejects.toThrow(/pg_dump exited with code 1: connection refused/);
  });

  it("rejects when pg_dump exits non-zero AFTER gzip drains (race fix)", async () => {
    // Repro the production bug: pg_dump writes an error to stderr, closes
    // stdout immediately (so gzip 'end' fires first), THEN exits with code 1.
    // The race-free implementation should still reject with the stderr.
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const promise = pgDumpToBuffer("postgres://bad", spawnFn);

    child.pushStderr("server version mismatch");
    child.stdout.end();
    await new Promise((r) => setImmediate(r));
    child.finish(1);

    await expect(promise).rejects.toThrow(/pg_dump exited with code 1: server version mismatch/);
  });

  it("rejects when pg_dump exits 0 but produces a near-empty gzip (silent fail floor)", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const promise = pgDumpToBuffer("postgres://x", spawnFn);

    child.pushStderr("permission denied");
    child.finish(0); // misleading clean exit

    await expect(promise).rejects.toThrow(/exited 0 but produced only \d+ bytes.*permission denied/);
  });

  it("rejects on spawn error", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const promise = pgDumpToBuffer("postgres://x", spawnFn);

    child.fail(new Error("ENOENT pg_dump"));
    await expect(promise).rejects.toThrow(/ENOENT pg_dump/);
  });
});

describe("runBackup", () => {
  it("PUTs the gzipped dump to the configured bucket with the dated key", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const send = vi.fn().mockResolvedValue({});
    const fakeS3 = { send } as unknown as Parameters<typeof runBackup>[0]["s3"];

    const promise = runBackup({
      databaseUrl: "postgres://u:p@h/db",
      r2: {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        accessKeyId: "ak",
        secretAccessKey: "sk",
        bucket: "home-systems-backups",
      },
      now: () => new Date(Date.UTC(2026, 4, 11, 3, 15)),
      s3: fakeS3,
      spawnFn,
    });

    const REAL_DUMP =
      "-- PostgreSQL database dump\n" +
      "SET statement_timeout = 0;\nSET client_encoding = 'UTF8';\n" +
      "CREATE TABLE foo (id int PRIMARY KEY, label text);\n" +
      "INSERT INTO foo VALUES (1, 'hello');\n";
    child.pushStdout(REAL_DUMP);
    child.finish(0);

    const result = await promise;

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({
      Bucket: "home-systems-backups",
      Key: "home-systems/2026-05-11T0315Z.sql.gz",
      ContentType: "application/gzip",
    });
    expect(cmd.input.Body).toBeInstanceOf(Buffer);
    expect(gunzipSync(cmd.input.Body as Buffer).toString()).toBe(REAL_DUMP);
    expect(result.key).toBe("home-systems/2026-05-11T0315Z.sql.gz");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates pg_dump failures without calling S3", async () => {
    const child = makeFakeChild();
    const spawnFn = fakeSpawnReturning(child);
    const send = vi.fn().mockResolvedValue({});
    const fakeS3 = { send } as unknown as Parameters<typeof runBackup>[0]["s3"];

    const promise = runBackup({
      databaseUrl: "postgres://x",
      r2: { endpoint: "https://a.r2.cloudflarestorage.com", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
      s3: fakeS3,
      spawnFn,
    });

    child.pushStderr("auth failed");
    child.finish(2);

    await expect(promise).rejects.toThrow(/auth failed/);
    expect(send).not.toHaveBeenCalled();
  });
});
