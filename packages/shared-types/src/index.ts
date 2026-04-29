// Shared API surface types between the Bun + Hono backend (apps/api) and the
// React web client (apps/web). When the Swift iOS bridge gets a generated
// client this file's types will drive it too.

// ── /api/me + /api/me/profile ──────────────────────────────────────────────
//
// Mirrors the columns we keep in sync with Clerk on every /clerk/exchange:
// the editable handle (display_name) plus first_name / last_name / username /
// image_url scraped from the Clerk Backend API. `email` is the verified
// primary address Clerk gave us at last login — null if Clerk hasn't yet
// resolved one (e.g. social login mid-flight).

export interface MeIdentity {
  user_id: string;
  display_name: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string | null;
  is_admin: boolean;
}

export interface MeProfile extends MeIdentity {
  bio: string;
  avatar_path: string | null;
  custom_fields: Record<string, unknown>;
}
