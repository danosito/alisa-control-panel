// Browser storage keys in one place. The session token lives in
// localStorage: this device stays signed in (the server can revoke it from
// "Устройства и ключи"); layouts and caches live there too.
export const SESSION_KEY = "panel.session";
export const WORKSPACE_KEY = "panel.workspace.v4";
export const COVERS_KEY = "panel.covers.v1";

/** One-time move of keys written by pre-release builds (prefix "igor."). */
export function migrateLegacyStorage(): void {
  const moves: Array<[Storage, string, string]> = [
    [sessionStorage, "igor.session", SESSION_KEY],
    // Up to 0.4 the token was per tab: keep the tab that is open signed in.
    [sessionStorage, SESSION_KEY, SESSION_KEY],
    [localStorage, "igor.workspace.v4", WORKSPACE_KEY],
    [localStorage, "igor.covers.v1", COVERS_KEY],
  ];
  for (const [store, from, to] of moves) {
    try {
      const value = store.getItem(from);
      const target = to === SESSION_KEY ? localStorage : store;
      if (value !== null && target.getItem(to) === null) target.setItem(to, value);
      if (store !== target || from !== to) store.removeItem(from);
    } catch { /* storage disabled */ }
  }
}

export const session = {
  get: (): string => { try { return localStorage.getItem(SESSION_KEY) ?? ""; } catch { return ""; } },
  set: (token: string): void => { try { localStorage.setItem(SESSION_KEY, token); } catch { /* private mode */ } },
  clear: (): void => { try { localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ } },
};

/** WebSocket subprotocols carrying the session (browsers cannot set headers). */
export const wsProtocols = (): string[] => ["panel.v1", `panel-auth.${session.get()}`];
