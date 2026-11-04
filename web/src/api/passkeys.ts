// WebAuthn ceremonies shared by the login screen and "Устройства и ключи".
import { ApiRequestError, type ApiClient } from "./client";

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const buffer = (bytes: Uint8Array) => bytes as unknown as BufferSource;

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && "credentials" in navigator;
}

/** This authenticator already holds a key for the panel (excludeCredentials hit). */
export class PasskeyExistsError extends Error {
  constructor() { super("На этом устройстве уже есть ключ панели."); this.name = "PasskeyExistsError"; }
}

/** The user closed the browser prompt, or the device has no matching key. */
export class PasskeyCancelledError extends Error {
  constructor(message: string) { super(message); this.name = "PasskeyCancelledError"; }
}

interface UADataValues { model?: string; platform?: string }
interface UAData { platform?: string; mobile?: boolean; getHighEntropyValues?(hints: string[]): Promise<UADataValues> }

/** "MacBook · Chrome", "iPhone · Safari", "vivo X200 Pro · Chrome". */
export async function deviceLabel(): Promise<string> {
  const ua = navigator.userAgent;
  const browser = /YaBrowser/.test(ua) ? "Яндекс Браузер" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "браузер";
  let device = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /CrOS/.test(ua) ? "Chromebook"
    : /Linux/.test(ua) ? "Linux" : "Устройство";
  // Chromium on Android hides the model in the UA string but tells it here.
  const data = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
  if (device === "Android" && data?.getHighEntropyValues) {
    try {
      const values = await data.getHighEntropyValues(["model"]);
      if (values.model && values.model.trim()) device = values.model.trim();
    } catch { /* not allowed: keep "Android" */ }
  }
  return `${device} · ${browser}`;
}

function cancelled(error: unknown, fallback: string): never {
  if (error instanceof DOMException && error.name === "InvalidStateError") throw new PasskeyExistsError();
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) throw new PasskeyCancelledError(fallback);
  throw error;
}

/**
 * Creates a passkey on this device and returns the new session.
 * {owner}: the very first key; {invite}: pairing code from a signed-in device;
 * neither: another key for an already signed-in device.
 */
export async function createPasskey(api: ApiClient, input: { owner?: string; invite?: string; name: string }): Promise<string> {
  const options = await api.registrationOptions({ owner: input.owner, invite: input.invite });
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.create({ publicKey: {
      challenge: buffer(fromBase64Url(options.challenge)),
      rp: options.rp,
      user: { id: buffer(fromBase64Url(options.user.id)), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
      authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria,
      attestation: options.attestation as AttestationConveyancePreference,
      excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ type: "public-key" as const, id: buffer(fromBase64Url(c.id)) })),
    } }) as PublicKeyCredential | null;
  } catch (error) { cancelled(error, "Создание ключа отменено."); }
  if (!credential) throw new PasskeyCancelledError("Создание ключа отменено.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const result = await api.registrationVerify({
    owner: input.owner,
    invite: input.invite,
    name: input.name,
    attestationObject: toBase64Url(response.attestationObject),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
  });
  return result.session;
}

/** Signs in with any passkey of the panel on this device; returns the session. */
export async function signInWithPasskey(api: ApiClient): Promise<string> {
  const [options, device] = await Promise.all([api.loginOptions(), deviceLabel()]);
  let credential: PublicKeyCredential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: {
      challenge: buffer(fromBase64Url(options.challenge)),
      rpId: options.rpId,
      userVerification: options.userVerification as UserVerificationRequirement,
    } }) as PublicKeyCredential | null;
  } catch (error) { cancelled(error, "Вход отменён."); }
  if (!credential) throw new PasskeyCancelledError("Вход отменён.");
  const response = credential.response as AuthenticatorAssertionResponse;
  const result = await api.loginVerify({
    credentialId: toBase64Url(credential.rawId),
    authenticatorData: toBase64Url(response.authenticatorData),
    clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
    signature: toBase64Url(response.signature),
    device,
  });
  return result.session;
}

/** Human message for an error of a passkey ceremony or its API calls. */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "invalid_invite": return "Код не подошёл или истёк. Создайте новый на подключённом устройстве.";
      case "invite_expired": return "Код уже использован или истёк. Создайте новый.";
      case "invite_required": return "Это устройство ещё не подключено: откройте «Устройства и ключи» на подключённом и отсканируйте QR.";
      case "already_registered": return "Этот ключ уже подключён — просто войдите.";
      case "too_many_passkeys": return "Слишком много ключей: удалите старый в «Устройства и ключи».";
      case "UnknownCredential": return "Этот ключ удалён из панели. Подключите устройство заново по коду.";
      default: return "Не удалось подтвердить ключ.";
    }
  }
  return error instanceof Error ? error.message : "Не удалось подтвердить ключ.";
}

/** Link that opens the pairing flow on a new device. */
export function pairingLink(code: string): string {
  return `${location.origin}/#pair=${code}`;
}

/** "K7Q2MX4D" -> "K7Q2-MX4D". */
export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Pairing code from the URL fragment (#pair=K7Q2MX4D), if any. */
export function pairingCodeFromUrl(): string | null {
  const match = /(?:^|[#&])pair=([A-Za-z0-9-]{8,9})/.exec(location.hash);
  return match ? match[1]!.replace(/-/g, "").toUpperCase() : null;
}

export function clearPairingFromUrl(): void {
  if (location.hash.includes("pair=")) history.replaceState(null, "", location.pathname + location.search);
}
