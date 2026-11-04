import { ApiRequestError, ApiUnreachableError, type ApiClient } from "../api/client";
import { createLiveClient } from "../api/live";
import { clearPairingFromUrl, pairingCodeFromUrl } from "../api/passkeys";
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

  /** Ends the session on the server too (unless it is already gone there). */
  function logout(serverSide = true): void {
    if (serverSide && session.get()) void api.logout().catch(() => undefined);
    session.clear();
    window.clearTimeout(timer);
    workspace?.destroy(); workspace = null;
    mountAuth();
  }

  function mountAuth(message?: string): void {
    const screen = createAuthScreen(api, () => mountHome(), { pairingCode: pairingCodeFromUrl() });
    root.replaceChildren(h("div", { class: "app-shell" }, screen.el));
    void api.authStatus().then((status) => { owner = status.owner; screen.setStatus(status); }).catch((error) => screen.setError(describeFailure(error)));
    if (message) screen.setError(message);
  }

  function mountHome(): void {
    workspace?.destroy();
    workspace = createWorkspace(api, live, { onLogout: () => logout(), onRefresh: () => void sync(true), owner });
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
      try { const snapshot = await api.dashboard(); workspace.setData(toData(snapshot)); workspace.setLayoutRevision(snapshot.layout_revision ?? 0); }
      catch (error) { if (error instanceof ApiRequestError && error.status === 401) { logout(false); return; } }
      finally { inFlight = false; }
    }
    timer = window.setTimeout(() => void sync(), workspace.syncIntervalMs() ?? IDLE_CHECK_MS);
  }

  const onVisibility = () => { if (document.visibilityState === "visible") void sync(true); };
  document.addEventListener("visibilitychange", onVisibility);
  // The live socket was closed because this device was signed out elsewhere.
  const onSignedOut = () => { if (workspace) logout(false); };
  window.addEventListener("panel:signed-out", onSignedOut);
  // A pairing link pasted into an open login tab only changes the hash.
  const onHash = () => { if (!workspace && pairingCodeFromUrl()) mountAuth(); };
  window.addEventListener("hashchange", onHash);

  void (async () => {
    try {
      const status = await api.authStatus();
      owner = status.owner;
      if (status.name) document.title = `${status.name} — панель управления`;
      if (session.get() && status.configured) {
        // Opening a pairing link on an already connected device: nothing to do.
        try { await api.authSession(); clearPairingFromUrl(); mountHome(); return; } catch { session.clear(); }
      }
      mountAuth();
    } catch (error) { mountAuth(describeFailure(error)); }
  })();

  return { stop() { stopped = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("panel:signed-out", onSignedOut); window.removeEventListener("hashchange", onHash); workspace?.destroy(); } };
}
