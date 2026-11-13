import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import stylesheet from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tenet — Your servers, your control" },
      {
        name: "description",
        content:
          "Tenet is an independent home for your servers and services. Built for self-hosting.",
      },
    ],
    links: [{ rel: "stylesheet", href: stylesheet }],
  }),
  component: RootLayout,
  notFoundComponent: () => (
    <p>
      Page not found. <Link to="/">Return home</Link>.
    </p>
  ),
});

function RootLayout() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="website-shell">
          <header className="website-nav">
            <Link className="brand" to="/">
              tenet
            </Link>
            <span>Independent by design.</span>
          </header>
          <main id="main">
            <Outlet />
          </main>
          <footer>Tenet · Built for self-hosting.</footer>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
