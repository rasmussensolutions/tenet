import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@tenet/ui/page-header";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({ meta: [{ title: "Projects — Tenet" }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  return <PageHeader title="Projects" />;
}
