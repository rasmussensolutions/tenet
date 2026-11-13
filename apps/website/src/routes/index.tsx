import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: HomePage });

function HomePage() {
  const dashboardUrl =
    import.meta.env.VITE_DASHBOARD_URL || "http://localhost:3000";

  return (
    <section className="hero">
      <p className="eyebrow">YOUR INFRASTRUCTURE. YOUR RULES.</p>
      <h1>
        Your servers.
        <br />
        One place to call home.
      </h1>
      <p className="hero-description">
        Tenet is being built to bring your machines, applications, and databases
        together. Host it your way. Keep control of what you run.
      </p>
      <a className="primary-link" href={dashboardUrl}>
        Explore the dashboard <span aria-hidden="true">↗</span>
      </a>
      <p className="development-note">Early development. More to come.</p>
    </section>
  );
}
