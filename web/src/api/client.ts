import { session } from "./storage";
import type { ApiErrorBody, ApiErrorCode, AuthStatus, DashboardSnapshot, LedState, LightAlgo, LightMode, LoginOptions, RegistrationOptions, SessionResponse } from "./types";

export type MediaAction = "play" | "pause" | "next" | "previous" | "stop";
export interface LedModePatch { mode?: LightMode; algo?: LightAlgo; r?: number; g?: number; b?: number; brightness?: number; speed?: number; sensitivity?: number }

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly path: string;

  constructor(path: string, status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.path = path;
    this.status = status;
    this.code = code;
  }

  get isAdapterPending(): boolean {
    return this.status === 501 || this.code === "adapter_pending";
  }
}

/** Thrown when the backend cannot be reached at all (network, CORS, server down). */
export class ApiUnreachableError extends Error {
  readonly path: string;
  override readonly cause: unknown;
  constructor(path: string, cause: unknown) {
    super(`Backend unreachable: ${path}`);
    this.name = "ApiUnreachableError";
    this.path = path;
    this.cause = cause;
  }
}

export interface ApiClient {
  dashboard(): Promise<DashboardSnapshot>;
  authSession(): Promise<{ ok: boolean; authenticated: boolean }>;
  ledSet(color: { r: number; g: number; b: number; brightness: number }): Promise<{ ok: boolean; led: LedState }>;
  ledMode(patch: LedModePatch): Promise<{ ok: boolean; led: LedState }>;
  volumeSet(volume: number): Promise<{ ok: boolean; volume: number }>;
  media(action: MediaAction): Promise<{ ok: boolean; action: string }>;
  authStatus(): Promise<AuthStatus>;
  registrationOptions(owner: string): Promise<RegistrationOptions>;
  registrationVerify(payload: { owner: string; attestationObject: string; clientDataJSON: string }): Promise<SessionResponse>;
  loginOptions(): Promise<LoginOptions>;
  loginVerify(payload: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }): Promise<SessionResponse>;
  /** PANEL_AUTH=password */
  passwordLogin(password: string): Promise<SessionResponse>;
  bluetoothAction(action: "pairing/start" | "pairing/stop"): Promise<unknown>;
  bluetoothDeviceAction(action: "connect" | "disconnect" | "remove", address: string): Promise<unknown>;
  /** Generic GET for endpoints that are added to the contract later. */
  get<T>(path: string): Promise<T>;
  post<T>(path: string, payload: unknown): Promise<T>;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? "/api/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 6000;

  async function request<T>(method: "GET" | "POST", path: string, payload?: unknown, timeout = timeoutMs): Promise<T> {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...(session.get() ? { Authorization: `Bearer ${session.get()}` } : {}) },
        body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (cause) {
      throw new ApiUnreachableError(path, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }

    if (!response.ok) {
      if (response.status === 401) session.clear();
      if (isApiErrorBody(body)) {
        throw new ApiRequestError(path, response.status, body.error, body.message);
      }
      throw new ApiRequestError(path, response.status, "http_error", response.statusText || "Request failed");
    }
    return body as T;
  }

  const get = <T>(path: string) => request<T>("GET", path);
  const post = <T>(path: string, payload: unknown) => request<T>("POST", path, payload);

  return {
    get,
    post,
    dashboard: () => get<DashboardSnapshot>("/dashboard"),
    authSession: () => get<{ ok: boolean; authenticated: boolean }>("/auth/session"),
    ledSet: (color) => post("/led/color", color),
    ledMode: (patch) => post("/led/mode", patch),
    volumeSet: (volume) => post("/audio/volume", { volume: Math.round(volume) }),
    media: (action) => post(`/media/${action}`, {}),
    authStatus: () => get<AuthStatus>("/auth/status"),
    registrationOptions: (owner: string) => post<RegistrationOptions>("/auth/register/options", { owner }),
    registrationVerify: (payload) => post<SessionResponse>("/auth/register/verify", payload),
    loginOptions: () => post<LoginOptions>("/auth/login/options", {}),
    loginVerify: (payload) => post<SessionResponse>("/auth/login/verify", payload),
    passwordLogin: (password) => post<SessionResponse>("/auth/password/login", { password }),
    bluetoothAction: (action) => post(`/bluetooth/${action}`, {}),
    // BlueZ Connect waits for the remote side: allow ~25 s.
    bluetoothDeviceAction: (action, address) => request("POST", `/bluetooth/${action}`, { address }, 30000),
  };
}
