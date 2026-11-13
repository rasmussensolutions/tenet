import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { api, type SessionInfo } from "@/lib/auth";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    try {
      return { auth: await api<SessionInfo>("/session") };
    } catch {
      throw redirect({ to: "/login" });
    }
  },
  component: DashboardLayout,
});
function DashboardLayout() {
  const { auth } = Route.useRouteContext();
  const securityPage = useMatch({
    from: "/_authenticated/security",
    shouldThrow: false,
  });
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const check = () => {
      if (!document.hidden) void api("/session").catch(() => {});
    };
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, []);
  return (
    <SidebarProvider className="h-dvh min-h-0 overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <SidebarTrigger />
          <Separator
            orientation="vertical"
            className="h-4 data-vertical:self-center"
          />
          <span className="text-sm text-muted-foreground">
            {auth.user.name}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/security"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Security
            </Link>
            <Button
              variant="ghost"
              size="sm"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await api("/auth/sign-out", {});
                  location.assign("/login");
                } catch {
                  setError("Sign-out failed. Please try again.");
                  setSigningOut(false);
                }
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <div
          id="main"
          tabIndex={-1}
          data-scroll-restoration-id="dashboard-content"
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-none"
        >
          <div className="mx-auto w-full max-w-7xl p-6 md:p-10">
            {error && (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {error}
              </p>
            )}
            {auth.recoveryCodesRemaining === 0 && !securityPage && (
              <p className="mb-6 rounded-lg border border-border bg-muted/50 p-4 text-sm">
                Protect against losing your passkey.{" "}
                <Link
                  to="/security"
                  className="font-medium underline underline-offset-4"
                >
                  Save your recovery codes
                </Link>
                .
              </p>
            )}
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
