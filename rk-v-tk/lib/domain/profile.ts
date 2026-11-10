export class ProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

export type ProfileInput = { username: string; displayName: string | null };

export function parseProfileInput(value: unknown): ProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileError("INVALID_PROFILE", "Provide a profile object.", 422);
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["username", "displayName"].includes(key))) {
    throw new ProfileError("INVALID_PROFILE", "Only username and displayName are accepted.", 422);
  }
  if (typeof input.username !== "string") {
    throw new ProfileError("INVALID_USERNAME", "A username is required.", 422);
  }
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    throw new ProfileError("INVALID_USERNAME", "Use 3–30 letters, numbers, or underscores.", 422);
  }
  if (input.displayName != null && typeof input.displayName !== "string") {
    throw new ProfileError("INVALID_DISPLAY_NAME", "Display name must be text.", 422);
  }
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() || null : null;
  if (displayName && [...displayName].length > 80) {
    throw new ProfileError("INVALID_DISPLAY_NAME", "Display name must be at most 80 characters.", 422);
  }
  if (displayName?.includes("\u0000")) {
    throw new ProfileError("INVALID_DISPLAY_NAME", "Display name contains an invalid character.", 422);
  }
  return { username, displayName };
}

export type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};
