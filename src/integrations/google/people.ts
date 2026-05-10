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
};

const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,metadata";

export function toGooglePerson(p: people_v1.Schema$Person): GooglePerson {
  const primaryName = p.names?.[0];
  return {
    resource_name: p.resourceName ?? "",
    display_name: primaryName?.displayName ?? null,
    given_name: primaryName?.givenName ?? null,
    family_name: primaryName?.familyName ?? null,
    emails: (p.emailAddresses ?? []).map((e) => e.value ?? "").filter(Boolean),
    phones: (p.phoneNumbers ?? []).map((n) => n.value ?? "").filter(Boolean),
    updated_at: p.metadata?.sources?.[0]?.updateTime ?? null,
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
