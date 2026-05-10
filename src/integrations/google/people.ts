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

export async function listAllConnections(client: OAuth2Client): Promise<GooglePerson[]> {
  const people = google.people({ version: "v1", auth: client });
  const out: GooglePerson[] = [];
  let pageToken: string | undefined;
  do {
    const res = await people.people.connections.list({
      resourceName: "people/me",
      personFields: PERSON_FIELDS,
      pageSize: 1000,
      sortOrder: "LAST_NAME_ASCENDING",
      pageToken,
    });
    for (const conn of res.data.connections ?? []) {
      out.push(toGooglePerson(conn));
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}
