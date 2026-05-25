import { google, people_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export type GooglePerson = {
  resource_name: string;
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  emails: string[];
  phones: string[];
  updated_at: string | null;
  // Extended identity fields used by sync
  biography: string | null;
  birthday: string | null; // "YYYY-MM-DD" or "MM-DD" if year is unknown
  birthday_year: number | null;
  job_title: string | null;
  company: string | null;
  image_url: string | null;
  linkedin_url: string | null;
  website: string | null;
  address: string | null;
};

const PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,metadata,biographies,birthdays,organizations,photos,urls,addresses";

const SOCIAL_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "telegram.org",
  "t.me",
  "wa.me",
  "whatsapp.com",
];

function pickBirthday(birthdays: people_v1.Schema$Birthday[] | undefined): { date: string | null; year: number | null } {
  for (const b of birthdays ?? []) {
    if (b.date) {
      const { year, month, day } = b.date;
      if (typeof month === "number" && typeof day === "number") {
        const mm = String(month).padStart(2, "0");
        const dd = String(day).padStart(2, "0");
        if (typeof year === "number" && year > 0) {
          return { date: `${year}-${mm}-${dd}`, year };
        }
        return { date: `${mm}-${dd}`, year: null };
      }
    }
  }
  return { date: null, year: null };
}

function pickUrl(urls: people_v1.Schema$Url[] | undefined, predicate: (host: string) => boolean): string | null {
  for (const u of urls ?? []) {
    const v = u.value?.trim();
    if (!v) continue;
    let host = "";
    try {
      const parsed = new URL(v.startsWith("http") ? v : `https://${v}`);
      host = parsed.host.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    if (predicate(host)) return v;
  }
  return null;
}

export function toGooglePerson(p: people_v1.Schema$Person): GooglePerson {
  const primaryName = p.names?.[0];
  const primaryOrg = p.organizations?.[0];
  const photoUrl = p.photos?.find((ph) => ph.url)?.url ?? null;
  const biography = p.biographies?.[0]?.value?.trim() || null;
  const address = p.addresses?.[0]?.formattedValue?.trim() || null;
  const { date: birthday, year: birthdayYear } = pickBirthday(p.birthdays ?? undefined);

  return {
    resource_name: p.resourceName ?? "",
    display_name: primaryName?.displayName ?? null,
    given_name: primaryName?.givenName ?? null,
    family_name: primaryName?.familyName ?? null,
    emails: (p.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
    phones: (p.phoneNumbers ?? []).map((n) => n.value ?? "").filter(Boolean),
    updated_at: p.metadata?.sources?.[0]?.updateTime ?? null,
    biography,
    birthday,
    birthday_year: birthdayYear,
    job_title: primaryOrg?.title ?? null,
    company: primaryOrg?.name ?? null,
    image_url: photoUrl,
    linkedin_url: pickUrl(p.urls ?? undefined, (host) => host.endsWith("linkedin.com")),
    website: pickUrl(p.urls ?? undefined, (host) => !SOCIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))),
    address,
  };
}

export async function listConnections(
  client: OAuth2Client,
  opts: { pageSize?: number; sortOrder?: "LAST_MODIFIED_DESCENDING" | "FIRST_NAME_ASCENDING" | "LAST_NAME_ASCENDING" } = {},
): Promise<GooglePerson[]> {
  const people = google.people({ version: "v1", auth: client });
  const res = await people.people.connections.list({
    resourceName: "people/me",
    personFields: PERSON_FIELDS,
    pageSize: opts.pageSize ?? 50,
    sortOrder: opts.sortOrder ?? "LAST_MODIFIED_DESCENDING",
  });
  return (res.data.connections ?? []).map(toGooglePerson);
}

export type ConnectionsDelta = {
  /** Created/changed contacts. */
  persons: GooglePerson[];
  /** resource_names of contacts deleted from Google since the sync token. */
  deleted: string[];
  /** Token to pass on the next run to fetch only what changed. */
  nextSyncToken: string | null;
  /** True when this was a full fetch (no token, or the token had expired). */
  fullSync: boolean;
};

/**
 * A People API sync token has expired/become invalid. The docs say 410, but
 * the API often returns 400 (INVALID_ARGUMENT / FAILED_PRECONDITION) with the
 * literal message "Sync token is expired. Clear local cache and retry call
 * without the sync token." Match both status codes plus that message as a
 * belt-and-suspenders so the fallback to full-sync always triggers.
 */
export function isExpiredSyncToken(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: { error?: { message?: unknown } } };
  };
  const httpStatus =
    typeof e.code === "number" ? e.code :
    typeof e.status === "number" ? e.status :
    typeof e.response?.status === "number" ? e.response.status : undefined;
  if (httpStatus === 410) return true;
  const candidates: string[] = [];
  if (typeof e.message === "string") candidates.push(e.message);
  const apiMsg = e.response?.data?.error?.message;
  if (typeof apiMsg === "string") candidates.push(apiMsg);
  return candidates.some((m) => /sync token.*expired|expired_sync_token/i.test(m));
}

/**
 * Fetch connections incrementally. With a `syncToken`, the People API returns
 * only contacts changed/deleted since that token; without one (or when the
 * token has expired) it does a full paginated fetch. Either way it requests a
 * fresh `nextSyncToken` to roll forward.
 */
export async function listConnectionsDelta(
  client: OAuth2Client,
  opts: { syncToken?: string | null } = {},
): Promise<ConnectionsDelta> {
  const api = google.people({ version: "v1", auth: client });
  const persons: GooglePerson[] = [];
  const deleted: string[] = [];

  const fetchAll = async (syncToken: string | undefined): Promise<string | null> => {
    persons.length = 0;
    deleted.length = 0;
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const res = await api.people.connections.list({
        resourceName: "people/me",
        personFields: PERSON_FIELDS,
        pageSize: 1000,
        requestSyncToken: true,
        ...(syncToken ? { syncToken } : {}),
        pageToken,
      });
      for (const conn of res.data.connections ?? []) {
        if (conn.metadata?.deleted) {
          if (conn.resourceName) deleted.push(conn.resourceName);
        } else {
          persons.push(toGooglePerson(conn));
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.nextSyncToken) nextSyncToken = res.data.nextSyncToken;
    } while (pageToken);
    return nextSyncToken;
  };

  if (opts.syncToken) {
    try {
      const nextSyncToken = await fetchAll(opts.syncToken);
      return { persons, deleted, nextSyncToken, fullSync: false };
    } catch (err) {
      if (!isExpiredSyncToken(err)) throw err;
      // Token expired — fall through to a full sync that mints a new one.
    }
  }
  const nextSyncToken = await fetchAll(undefined);
  return { persons, deleted, nextSyncToken, fullSync: true };
}
