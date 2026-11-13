import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowCircleUpIcon } from "@phosphor-icons/react/dist/csr/ArrowCircleUp";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { MagicWandIcon } from "@phosphor-icons/react/dist/csr/MagicWand";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { ScrollIcon } from "@phosphor-icons/react/dist/csr/Scroll";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

const navigationGroups = [
  {
    label: null,
    items: [
      { title: "Home", to: "/", icon: HouseIcon },
      { title: "Activity", to: "/activity", icon: ClockCounterClockwiseIcon },
      { title: "Ask AI", to: "/ask-ai", icon: ChatCircleDotsIcon },
    ],
  },
  {
    label: "Servers",
    items: [
      { title: "Machines", to: "/machines", icon: HardDrivesIcon },
      { title: "Services", to: "/services", icon: StackIcon },
      { title: "Projects", to: "/projects", icon: SquaresFourIcon },
      { title: "Updates", to: "/updates", icon: ArrowCircleUpIcon },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Monitors", to: "/monitors", icon: PulseIcon },
      { title: "Logs", to: "/logs", icon: ScrollIcon },
      { title: "Backups", to: "/backups", icon: ArchiveIcon },
      { title: "Workflows", to: "/workflows", icon: FlowArrowIcon },
      { title: "Fixes", to: "/fixes", icon: MagicWandIcon },
    ],
  },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Tenet"
              render={<Link to="/" onClick={() => setOpenMobile(false)} />}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <TerminalWindowIcon aria-hidden="true" />
              </span>
              <span className="text-lg font-semibold tracking-tight">
                tenet
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main navigation">
          {navigationGroups.map((group) => (
            <SidebarGroup key={group.label ?? "main"}>
              {group.label ? (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              ) : null}
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        isActive={
                          pathname === item.to ||
                          (item.to !== "/" &&
                            pathname.startsWith(`${item.to}/`))
                        }
                        tooltip={item.title}
                        render={
                          <Link
                            to={item.to}
                            activeOptions={{ exact: item.to === "/" }}
                            onClick={() => setOpenMobile(false)}
                          />
                        }
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
