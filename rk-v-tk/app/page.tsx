import AuthProvider from "./components/AuthProvider";
import ProfilePanel from "./components/ProfilePanel";
import OddsBrowser from "./components/OddsBrowser";

export default function Home() {
  return (
    <AuthProvider>
      <main>
        <h1>RkVTk</h1>
        <p>Welcome to the arena.</p>
        <ProfilePanel />
        <OddsBrowser />
      </main>
    </AuthProvider>
  );
}
