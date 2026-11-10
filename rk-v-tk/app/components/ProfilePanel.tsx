"use client";

import { fetchAuthSession } from "aws-amplify/auth";
import { useEffect, useState, type FormEvent } from "react";
import type { Profile } from "@/lib/domain/profile";
import styles from "./ProfilePanel.module.css";

async function profileRequest(method: "GET" | "POST", body?: { username: string; displayName: string }) {
  const { tokens } = await fetchAuthSession();
  if (!tokens?.accessToken) throw new Error("Sign in again to access your profile.");
  const response = await fetch("/api/me", {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${tokens.accessToken.toString()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (method === "GET" && response.status === 404 && data.error?.code === "PROFILE_NOT_FOUND") return null;
  if (!response.ok) throw new Error(data.error?.message ?? "Unable to load your profile. Try again.");
  return data.profile as Profile;
}

export default function ProfilePanel() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsProfile, setNeedsProfile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    profileRequest("GET").then((found) => {
      if (!active) return;
      setProfile(found);
      setNeedsProfile(found === null);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Unable to load your profile.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    try {
      const created = await profileRequest("POST", {
        username: String(form.get("username") ?? ""),
        displayName: String(form.get("displayName") ?? ""),
      });
      setProfile(created);
      setNeedsProfile(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save your profile.");
    } finally { setSaving(false); }
  }

  return (
    <section className={styles.panel} aria-labelledby="profile-heading" aria-busy={loading || saving}>
      <h2 id="profile-heading">Your profile</h2>
      {loading && <p role="status">Loading your profile…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && profile && (
        <div>
          <p><strong>@{profile.username}</strong></p>
          {profile.displayName && <p>{profile.displayName}</p>}
          <p>Your profile is saved. RkVTk is a free-to-play simulation.</p>
        </div>
      )}
      {!loading && needsProfile && (
        <form onSubmit={register} className={styles.form}>
          <label htmlFor="profile-username">Username</label>
          <input id="profile-username" name="username" autoComplete="username" required
            minLength={3} maxLength={30} pattern="[A-Za-z0-9_]{3,30}"
            aria-describedby="username-help" disabled={saving} />
          <p id="username-help">3–30 letters, numbers, or underscores. Saved in lowercase.</p>
          <label htmlFor="profile-display-name">Display name (optional)</label>
          <input id="profile-display-name" name="displayName" autoComplete="nickname" maxLength={80} disabled={saving} />
          <button type="submit" disabled={saving}>{saving ? "Saving…" : "Create profile"}</button>
        </form>
      )}
      {!loading && error && !needsProfile && <button onClick={() => setAttempt((value) => value + 1)}>Try again</button>}
    </section>
  );
}
