import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createGzip } from "zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type R2Config = {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type SpawnFn = (command: string, args: readonly string[], options?: object) => ChildProcessWithoutNullStreams;

export function r2ObjectKey(now: Date, prefix = "home-systems"): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${prefix}/${y}-${m}-${d}T${hh}${mm}Z.sql.gz`;
}

export function pgDumpArgs(databaseUrl: string): string[] {
  return ["--no-owner", "--no-privileges", "--format=plain", databaseUrl];
}

/** Build the standard R2 S3 endpoint from a Cloudflare account ID. */
export function r2EndpointForAccount(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function makeR2Client(r2: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2.endpoint,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
}

/**
 * Empty-gzip sanity floor. A real pg_dump always emits at least the SET / SET
 * SESSION / `-- PostgreSQL database dump` banners (hundreds of bytes raw,
 * tens-of-bytes-plus compressed). If the gzip is smaller than this floor, the
 * process likely failed before emitting anything meaningful.
 */
const MIN_GZIP_BYTES = 100;

export async function pgDumpToBuffer(
  databaseUrl: string,
  spawnFn: SpawnFn = nodeSpawn as SpawnFn,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dump = spawnFn("pg_dump", pgDumpArgs(databaseUrl), { stdio: ["ignore", "pipe", "pipe"] });
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    let stderr = "";
    let exitCode: number | null = null;
    let gzipEnded = false;
    let settled = false;

    // Wait for BOTH dump 'exit' and gzip 'end' before deciding success/failure.
    // gzip 'end' fires when the upstream stdout closes — that can happen
    // BEFORE pg_dump has emitted its non-zero exit code (it writes the error
    // to stderr and closes stdout immediately). Without this barrier, an empty
    // gzip race-resolves before the failure registers.
    const finish = () => {
      if (settled) return;
      if (exitCode === null || !gzipEnded) return;
      settled = true;
      if (exitCode !== 0) {
        reject(new Error(`pg_dump exited with code ${exitCode}: ${stderr.trim()}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < MIN_GZIP_BYTES) {
        reject(
          new Error(
            `pg_dump exited 0 but produced only ${buf.length} bytes (gzipped). stderr: ${stderr.trim() || "(empty)"}`,
          ),
        );
        return;
      }
      resolve(buf);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    dump.stdout.pipe(gzip);
    dump.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    dump.on("error", fail);
    gzip.on("error", fail);
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", () => {
      gzipEnded = true;
      finish();
    });
    dump.on("exit", (code) => {
      exitCode = code;
      finish();
    });
  });
}

export type BackupOptions = {
  databaseUrl: string;
  r2: R2Config;
  now?: () => Date;
  s3?: S3Client;
  spawnFn?: SpawnFn;
};

export type BackupResult = {
  key: string;
  bytes: number;
  durationMs: number;
};

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const now = (opts.now ?? (() => new Date()))();
  const key = r2ObjectKey(now);
  const started = Date.now();
  const body = await pgDumpToBuffer(opts.databaseUrl, opts.spawnFn);
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
