import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({ meta: [{ title: "Home — Tenet" }] }),
  component: HomePage,
});

function HomePage() {
  return <PageHeader title="Home" />;
}
