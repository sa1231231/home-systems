import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createGzip } from "zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export type R2Config = {
  accountId: string;
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

export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export function makeR2Client(r2: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(r2.accountId),
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
}

export async function pgDumpToBuffer(
  databaseUrl: string,
  spawnFn: SpawnFn = nodeSpawn as SpawnFn,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const dump = spawnFn("pg_dump", pgDumpArgs(databaseUrl), { stdio: ["ignore", "pipe", "pipe"] });
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };

    dump.stdout.pipe(gzip);
    dump.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    dump.on("error", fail);
    gzip.on("error", fail);
    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
    gzip.on("end", () => done(Buffer.concat(chunks)));
    dump.on("exit", (code) => {
      if (code !== 0) fail(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
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
