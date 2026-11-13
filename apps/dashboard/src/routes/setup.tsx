import { createFileRoute } from "@tanstack/react-router";
import { AuthScreen } from "@/components/auth-screen";
export const Route = createFileRoute("/setup")({
  component: () => <AuthScreen mode="setup" />,
});
