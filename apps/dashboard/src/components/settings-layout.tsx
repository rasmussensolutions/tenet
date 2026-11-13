import { type ReactNode, useId } from "react";

export function SettingsPage({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-9">
      <header className="space-y-1.5 px-4 sm:px-5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="px-4 text-base font-medium sm:px-5">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function SettingsGroup({ children }: { children: ReactNode }) {
  return (
    <div className="@container divide-y rounded-xl border bg-card px-4 text-card-foreground shadow-xs sm:px-5">
      {children}
    </div>
  );
}

export function SettingsRow({
  title,
  description,
  control,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex flex-col gap-2.5 @lg:flex-row @lg:items-center @lg:justify-between @lg:gap-5">
        <div className="min-w-0 space-y-0.5 [overflow-wrap:anywhere]">
          <div className="text-sm font-medium">{title}</div>
          {description && (
            <div className="text-[0.8125rem] leading-5 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {control && <div className="min-w-0 @lg:shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3 min-w-0">{children}</div>}
    </div>
  );
}
