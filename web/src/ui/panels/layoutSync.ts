// Keeps the screens/widgets layout the same on every signed-in device.
// The station keeps one copy (GET/POST /api/v1/layout); /dashboard reports its
// revision, so a change made elsewhere is noticed by the polling that runs
// anyway. Last writer wins; remote changes wait while this device is editing.
import type { ApiClient } from "../../api/client";
import type { Panel, PanelStore } from "./store";

export interface LayoutSync {
  /** First contact: adopt the station's layout, or share ours if it has none. */
  start(): Promise<void>;
  /** Revision seen in /dashboard. */
  seen(revision: number): void;
  /** Edit mode ended: apply a remote change that arrived meanwhile. */
  resume(): void;
  destroy(): void;
}

export interface LayoutSyncOptions {
  canApply(): boolean;
  /** What a screen looks like on this device: changes elsewhere that do not alter it cause no rebuild. */
  viewKey(panel: Panel): string;
  /** Screens to rebuild after a remote change (deleted ones are dropped by the caller). */
  applied(changed: string[]): void;
}

const UPLOAD_DELAY_MS = 800;

export function createLayoutSync(api: ApiClient, store: PanelStore, options: LayoutSyncOptions): LayoutSync {
  let revision = -1;
  /** Layout text known to be on the station; equal local text means nothing to upload. */
  let remoteText = "";
  let timer: number | undefined;
  let uploading = false;
  let again = false;
  let deferred = false;
  let pulling = false;
  let stopped = false;

  const localText = () => JSON.stringify(store.shared());

  async function pull(): Promise<void> {
    if (pulling || stopped) return;
    pulling = true;
    try {
      const response = await api.layout();
      revision = response.revision;
      if (response.layout === null) { await push(true); return; }
      remoteText = JSON.stringify(response.layout);
      // A local change is waiting to be uploaded: it wins.
      if (timer !== undefined || uploading || remoteText === localText()) return;
      if (!options.canApply()) { deferred = true; return; }
      const changed = store.applyShared(response.layout, options.viewKey);
      if (changed) { remoteText = localText(); options.applied(changed); }
    } catch { /* offline: the next revision or change retries */ } finally { pulling = false; }
  }

  async function push(force = false): Promise<void> {
    timer = undefined;
    const text = localText();
    if (stopped || (!force && text === remoteText)) return;
    if (uploading) { again = true; return; }
    uploading = true;
    try {
      revision = (await api.saveLayout(store.shared())).revision;
      remoteText = text;
    } catch {
      window.setTimeout(schedule, 5000);
    } finally {
      uploading = false;
      if (again) { again = false; void push(); }
    }
  }

  function schedule(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void push(), UPLOAD_DELAY_MS);
  }

  const flush = () => { if (timer !== undefined) { window.clearTimeout(timer); void push(); } };
  const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
  document.addEventListener("visibilitychange", onVisibility);
  store.onChange = schedule;

  return {
    start: pull,
    seen(next) { if (revision >= 0 && next !== revision) void pull(); },
    resume() { if (deferred) { deferred = false; void pull(); } },
    destroy() {
      flush();
      stopped = true;
      store.onChange = null;
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
