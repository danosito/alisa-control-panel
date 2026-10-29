// Browser storage keys in one place. The session token lives in
// sessionStorage (per tab); layouts and caches in localStorage.
export const SESSION_KEY = "panel.session";
export const WORKSPACE_KEY = "panel.workspace.v4";
export const COVERS_KEY = "panel.covers.v1";

/** One-time move of keys written by pre-release builds (prefix "igor."). */
export function migrateLegacyStorage(): void {
  const moves: Array<[Storage, string, string]> = [
    [sessionStorage, "igor.session", SESSION_KEY],
    [localStorage, "igor.workspace.v4", WORKSPACE_KEY],
    [localStorage, "igor.covers.v1", COVERS_KEY],
  ];
  for (const [store, from, to] of moves) {
    try {
      const value = store.getItem(from);
      if (value !== null && store.getItem(to) === null) store.setItem(to, value);
      store.removeItem(from);
    } catch { /* storage disabled */ }
  }
}

export const session = {
  get: (): string => sessionStorage.getItem(SESSION_KEY) ?? "",
  set: (token: string): void => sessionStorage.setItem(SESSION_KEY, token),
  clear: (): void => sessionStorage.removeItem(SESSION_KEY),
};

/** WebSocket subprotocols carrying the session (browsers cannot set headers). */
export const wsProtocols = (): string[] => ["panel.v1", `panel-auth.${session.get()}`];
