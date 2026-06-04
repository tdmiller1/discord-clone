/** Client mirrors of the story-003 auth-api contract shapes (camelCase, epoch-ms numbers). */

/** The only user shape the server returns (password_hash and disabled are omitted). */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string | null;
  createdAt: number;
}

/** Body returned by POST /api/register, /api/login, and /api/refresh. */
export interface SessionResponse {
  session: string; // raw opaque token (Bearer + WS connect credential)
  expiresAt: number; // epoch ms
  user: PublicUser;
}
