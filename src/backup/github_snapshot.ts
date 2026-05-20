import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { makeR2Client, type R2Config } from "./pg_dump.js";

export type GithubSnapshotConfig = {
  /** "owner/repo", e.g. "sa1231231/home-systems". */
  repo: string;
  /** Branch / tag / commit SHA. Default "main". */
  ref?: string;
  /** GitHub personal-access token with `contents:read` on the repo. */
  token: string;
};

/** Object key for the gzipped tarball, sibling to the DB-backup key scheme. */
export function githubSnapshotKey(now: Date, prefix = "home-systems-source"): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${prefix}/${y}-${m}-${d}T${hh}${mm}Z.tar.gz`;
}

export type FetchFn = typeof fetch;

/**
 * Download a gzipped tarball of the repo at `ref`. GitHub returns a
 * pre-gzipped tar, so we just pull the bytes and upload them as-is.
 */
export async function fetchRepoTarball(
  cfg: GithubSnapshotConfig,
  fetchImpl: FetchFn = fetch,
): Promise<Buffer> {
  const ref = cfg.ref ?? "main";
  const url = `https://api.github.com/repos/${cfg.repo}/tarball/${ref}`;
  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "home-systems-backup",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github tarball fetch failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  // GitHub tarballs always have content; treat anything under a few KB as
  // suspicious (matches the spirit of pg_dump's MIN_GZIP_BYTES guard).
  if (buf.length < 1024) {
    throw new Error(`github tarball too small: ${buf.length} bytes`);
  }
  return buf;
}

export type GithubBackupOptions = {
  github: GithubSnapshotConfig;
  r2: R2Config;
  now?: () => Date;
  s3?: S3Client;
  fetchImpl?: FetchFn;
};

export type GithubBackupResult = {
  key: string;
  bytes: number;
  durationMs: number;
};

/** Pull the repo tarball from GitHub and PUT it to R2. */
export async function runGithubBackup(opts: GithubBackupOptions): Promise<GithubBackupResult> {
  const now = (opts.now ?? (() => new Date()))();
  const key = githubSnapshotKey(now);
  const started = Date.now();
  const body = await fetchRepoTarball(opts.github, opts.fetchImpl);
  const s3 = opts.s3 ?? makeR2Client(opts.r2);
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.r2.bucket,
      Key: key,
      Body: body,
      ContentType: "application/gzip",
    }),
  );
  return { key, bytes: body.length, durationMs: Date.now() - started };
}
