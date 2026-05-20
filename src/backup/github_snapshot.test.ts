import { describe, expect, it, vi } from "vitest";
import {
  fetchRepoTarball,
  githubSnapshotKey,
  runGithubBackup,
  type FetchFn,
} from "./github_snapshot.js";

const GH_CFG = {
  repo: "sa1231231/home-systems",
  ref: "main",
  token: "ghp-test",
};

function fakeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): FetchFn {
  return ((url: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(impl(url.toString(), init))) as FetchFn;
}

describe("githubSnapshotKey", () => {
  it("formats UTC date under the source prefix as YYYY-MM-DDTHHMMZ.tar.gz", () => {
    const d = new Date(Date.UTC(2026, 4, 20, 17, 30));
    expect(githubSnapshotKey(d)).toBe("home-systems-source/2026-05-20T1730Z.tar.gz");
  });

  it("respects a custom prefix", () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0));
    expect(githubSnapshotKey(d, "scratch")).toBe("scratch/2026-01-01T0000Z.tar.gz");
  });
});

describe("fetchRepoTarball", () => {
  it("hits the tarball endpoint with bearer auth + a UA and returns the body", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    const body = Buffer.alloc(50_000, 0x42);
    const fetchFn = fakeFetch((url, init) => {
      capturedUrl = url;
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(body, { status: 200 });
    });
    const buf = await fetchRepoTarball(GH_CFG, fetchFn);
    expect(capturedUrl).toBe("https://api.github.com/repos/sa1231231/home-systems/tarball/main");
    expect(capturedHeaders.Authorization).toBe("Bearer ghp-test");
    expect(capturedHeaders["User-Agent"]).toBeTruthy();
    expect(capturedHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(buf.length).toBe(50_000);
  });

  it("defaults ref to main when omitted", async () => {
    let capturedUrl = "";
    const body = Buffer.alloc(50_000);
    const fetchFn = fakeFetch((url) => {
      capturedUrl = url;
      return new Response(body, { status: 200 });
    });
    await fetchRepoTarball({ repo: "x/y", token: "t" }, fetchFn);
    expect(capturedUrl.endsWith("/tarball/main")).toBe(true);
  });

  it("throws on non-2xx with status code + truncated body", async () => {
    const fetchFn = fakeFetch(
      () => new Response("repo not found", { status: 404, statusText: "Not Found" }),
    );
    await expect(fetchRepoTarball(GH_CFG, fetchFn)).rejects.toThrow(/404 Not Found.*repo not found/);
  });

  it("throws when the returned tarball is suspiciously small", async () => {
    const fetchFn = fakeFetch(() => new Response(Buffer.alloc(50), { status: 200 }));
    await expect(fetchRepoTarball(GH_CFG, fetchFn)).rejects.toThrow(/tarball too small: 50 bytes/);
  });
});

describe("runGithubBackup", () => {
  it("PUTs the tarball to R2 with a dated source-prefixed key", async () => {
    const body = Buffer.alloc(75_000, 0x55);
    const fetchFn = fakeFetch(() => new Response(body, { status: 200 }));
    const send = vi.fn().mockResolvedValue({});
    const fakeS3 = { send } as unknown as Parameters<typeof runGithubBackup>[0]["s3"];

    const result = await runGithubBackup({
      github: GH_CFG,
      r2: {
        endpoint: "https://acct.r2.cloudflarestorage.com",
        accessKeyId: "ak",
        secretAccessKey: "sk",
        bucket: "hs-backup",
      },
      now: () => new Date(Date.UTC(2026, 4, 20, 17, 30)),
      s3: fakeS3,
      fetchImpl: fetchFn,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({
      Bucket: "hs-backup",
      Key: "home-systems-source/2026-05-20T1730Z.tar.gz",
      ContentType: "application/gzip",
    });
    expect(cmd.input.Body).toBeInstanceOf(Buffer);
    expect((cmd.input.Body as Buffer).length).toBe(75_000);
    expect(result.key).toBe("home-systems-source/2026-05-20T1730Z.tar.gz");
    expect(result.bytes).toBe(75_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates GitHub fetch failures without calling S3", async () => {
    const fetchFn = fakeFetch(() => new Response("denied", { status: 403, statusText: "Forbidden" }));
    const send = vi.fn().mockResolvedValue({});
    const fakeS3 = { send } as unknown as Parameters<typeof runGithubBackup>[0]["s3"];
    await expect(
      runGithubBackup({
        github: GH_CFG,
        r2: { endpoint: "x", accessKeyId: "a", secretAccessKey: "b", bucket: "c" },
        s3: fakeS3,
        fetchImpl: fetchFn,
      }),
    ).rejects.toThrow(/403 Forbidden/);
    expect(send).not.toHaveBeenCalled();
  });
});
