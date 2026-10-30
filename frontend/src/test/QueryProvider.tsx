import { Router, type RouteDefinition } from "@neo-ui-kit/react";
import { subscribeApplication } from "../providers/application";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { runInAction } from "mobx";
import { useEffect, useState, type PropsWithChildren } from "react";
import { store } from "../providers/store";
import { loadPreferences } from "../shared/preferences/preferences";

export const QueryProvider = ({ children, application = false }: PropsWithChildren<{ application?: boolean }>) => {
  const [client] = useState(() => {
    runInAction(() => {
      store.preferences = loadPreferences();
      store.settingsOpen = false;
      store.settingsTab = "appearance";
    });
    return new QueryClient({ defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: Infinity },
      mutations: { retry: false, networkMode: "always" },
    } });
  });
  useEffect(() => {
    const stop = application ? subscribeApplication(client) : undefined;
    return () => { stop?.(); client.clear(); };
  }, [client, application]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

export const TestRouter = ({ children, initialEntries = ["/"], routes, mode = "history" }: PropsWithChildren<{
  initialEntries?: string[]; routes?: readonly RouteDefinition[]; mode?: "hash" | "history";
}>) => {
  useState(() => { window.history.replaceState(null, "", mode === "hash" ? `/#${initialEntries[0]}` : initialEntries[0]); });
  return <Router mode={mode} routes={routes ?? [{ path: "*", element: children }]} />;
};
