import AuthProvider from "./components/AuthProvider";

export default function Home() {
  return (
    <AuthProvider>
      <main>
        <h1>RkVTk</h1>
        <p>Welcome to the arena.</p>
      </main>
    </AuthProvider>
  );
}