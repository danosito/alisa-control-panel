import { ApiRequestError, ApiUnreachableError, type ApiClient } from "../api/client";
import { createLiveClient } from "../api/live";
import { session } from "../api/storage";
import type { DashboardSnapshot } from "../api/types";
import { createAuthScreen } from "../ui/authScreen";
import { h } from "../ui/dom";
import { createWorkspace, type Workspace } from "../ui/workspace";
import type { DataSnapshot } from "../widgets/types";

export interface AppOptions { api: ApiClient; root: HTMLElement }
export interface App { stop(): void }

const IDLE_CHECK_MS = 2000;

function describeFailure(error: unknown): string {
  if (error instanceof ApiUnreachableError) return "Сервер панели недоступен.";
  if (error instanceof ApiRequestError) return `Сервер ответил ошибкой ${error.status}.`;
  return "Не удалось получить данные от сервера.";
}

const toData = (d: DashboardSnapshot): DataSnapshot => ({ capabilities: d.capabilities, state: d.state, metrics: d.metrics, history: d.metrics_history, devices: d.bluetooth_devices, media: d.media, system: d.system });

export function mountApp({ api, root }: AppOptions): App {
  let timer: number | undefined;
  let stopped = false;
  let workspace: Workspace | null = null;
  let inFlight = false;
  let owner = "";
  const live = createLiveClient();

  function logout(): void {
    session.clear();
    window.clearTimeout(timer);
    workspace?.destroy(); workspace = null;
    mountAuth();
  }

  function mountAuth(message?: string): void {
    const screen = createAuthScreen(api, () => mountHome());
    root.replaceChildren(h("div", { class: "app-shell" }, screen.el));
    void api.authStatus().then((status) => { owner = status.owner; screen.setStatus(status); }).catch((error) => screen.setError(describeFailure(error)));
    if (message) screen.setError(message);
  }

  function mountHome(): void {
    workspace?.destroy();
    workspace = createWorkspace(api, live, { onLogout: logout, onRefresh: () => void sync(true), owner });
    root.replaceChildren(h("div", { class: "app-shell" }, workspace.el));
    void sync(true);
  }

  /** One request feeds every widget; how often depends on what is on screen. */
  async function sync(force = false): Promise<void> {
    window.clearTimeout(timer);
    if (stopped || !workspace) return;
    const interval = workspace.syncIntervalMs();
    const due = force || interval !== null;
    if (due && !inFlight && document.visibilityState === "visible") {
      inFlight = true;
      try { workspace.setData(toData(await api.dashboard())); }
      catch (error) { if (error instanceof ApiRequestError && error.status === 401) { logout(); return; } }
      finally { inFlight = false; }
    }
    timer = window.setTimeout(() => void sync(), workspace.syncIntervalMs() ?? IDLE_CHECK_MS);
  }

  const onVisibility = () => { if (document.visibilityState === "visible") void sync(true); };
  document.addEventListener("visibilitychange", onVisibility);

  void (async () => {
    try {
      const status = await api.authStatus();
      owner = status.owner;
      if (status.name) document.title = `${status.name} — панель управления`;
      if (session.get() && status.configured) {
        try { await api.authSession(); mountHome(); return; } catch { session.clear(); }
      }
      mountAuth();
    } catch (error) { mountAuth(describeFailure(error)); }
  })();

  return { stop() { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); workspace?.destroy(); } };
}
