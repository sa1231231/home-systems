/**
 * End-to-end smoke test for the R2 backup pipeline.
 *
 *   1. Logs into the deployed UI to get a session cookie.
 *   2. POSTs to /admin/<backup endpoint>.
 *   3. HEADs the returned object key in R2 to confirm it landed.
 *   4. DELETEs the test artifact (it's the one *this* run just created — the
 *      prior scheduled backups stay untouched).
 *   5. Re-HEADs to confirm the delete took.
 *
 * Required env (read from process env so it composes with `railway run`):
 *   BACKUP_URL                — base URL of the deployed app (no trailing /)
 *   UI_PASSWORD               — to log in
 *   R2_ENDPOINT               — same one the server uses
 *   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *
 * Optional flags:
 *   --kind=db        (default) — uses /admin/backup-now
 *   --kind=github             — uses /admin/github-backup-now
 *   --keep                    — skip the delete step (eg if you want to inspect the object)
 *
 * Exit code: 0 on full success, 1 on any failure.
 */
import "dotenv/config";
import { HeadObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

type BackupKind = "db" | "github";

function parseArgs(): { kind: BackupKind; keep: boolean } {
  const args = process.argv.slice(2);
  let kind: BackupKind = "db";
  let keep = false;
  for (const a of args) {
    if (a === "--keep") keep = true;
    else if (a.startsWith("--kind=")) {
      const v = a.slice("--kind=".length);
      if (v !== "db" && v !== "github") throw new Error(`unknown --kind: ${v}`);
      kind = v;
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return { kind, keep };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

function endpointForKind(kind: BackupKind): string {
  return kind === "github" ? "/admin/github-backup-now" : "/admin/backup-now";
}

async function login(baseUrl: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/ui/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
    redirect: "manual",
  });
  if (res.status !== 302 && res.status !== 303) {
    throw new Error(`login failed: status ${res.status}`);
  }
  const cookies = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const session = cookies.find((c) => c.startsWith("hs_session="));
  if (!session) throw new Error("login response did not include hs_session cookie");
  return session.split(";")[0];
}

async function triggerBackup(
  baseUrl: string,
  cookie: string,
  kind: BackupKind,
): Promise<{ key: string; bytes: number; bucket: string; duration_ms: number }> {
  const url = `${baseUrl}${endpointForKind(kind)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Cookie: cookie, Accept: "application/json" },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) {
    throw new Error(
      `backup endpoint ${url} returned ${res.status}: ${JSON.stringify(body)}`,
    );
  }
  return {
    key: String(body.key),
    bytes: Number(body.bytes),
    bucket: String(body.bucket),
    duration_ms: Number(body.duration_ms),
  };
}

async function headObject(s3: S3Client, bucket: string, key: string): Promise<number | null> {
  try {
    const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return out.ContentLength ?? 0;
  } catch (err) {
    const name = (err as { name?: string }).name ?? "";
    if (name === "NotFound" || name === "NoSuchKey") return null;
    throw err;
  }
}

async function main() {
  const { kind, keep } = parseArgs();
  const baseUrl = requireEnv("BACKUP_URL").replace(/\/$/, "");
  const password = requireEnv("UI_PASSWORD");
  const r2Endpoint = requireEnv("R2_ENDPOINT");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const expectedBucket = requireEnv("R2_BUCKET");

  console.log(`[verify] kind=${kind} url=${baseUrl}`);

  const cookie = await login(baseUrl, password);
  console.log("[verify] logged in");

  console.log(`[verify] triggering ${endpointForKind(kind)}`);
  const t0 = Date.now();
  const r = await triggerBackup(baseUrl, cookie, kind);
  console.log(
    `[verify] backup wrote bucket=${r.bucket} key=${r.key} bytes=${r.bytes} server_ms=${r.duration_ms} client_ms=${Date.now() - t0}`,
  );
  if (r.bucket !== expectedBucket) {
    throw new Error(`bucket mismatch: server=${r.bucket} env=${expectedBucket}`);
  }
  if (r.bytes < 1024) {
    throw new Error(`suspiciously small backup: ${r.bytes} bytes`);
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: r2Endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const sizeOnR2 = await headObject(s3, r.bucket, r.key);
  if (sizeOnR2 === null) throw new Error(`R2 HEAD ${r.key} returned NotFound`);
  console.log(`[verify] R2 HEAD ok: size=${sizeOnR2}`);
  if (sizeOnR2 !== r.bytes) {
    throw new Error(`size mismatch: server reported ${r.bytes}, R2 reports ${sizeOnR2}`);
  }

  if (keep) {
    console.log(`[verify] --keep set; leaving ${r.key} in place`);
    console.log("[verify] OK");
    return;
  }

  await s3.send(new DeleteObjectCommand({ Bucket: r.bucket, Key: r.key }));
  const sizeAfter = await headObject(s3, r.bucket, r.key);
  if (sizeAfter !== null) throw new Error(`delete failed: object still present after DELETE`);
  console.log(`[verify] deleted ${r.key}; HEAD now NotFound`);
  console.log("[verify] OK");
}

main().catch((err) => {
  console.error("[verify] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
