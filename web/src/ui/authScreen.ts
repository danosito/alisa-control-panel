import { ApiRequestError, type ApiClient } from "../api/client";
import { session } from "../api/storage";
import type { AuthStatus } from "../api/types";
import { h, svgIcon } from "./dom";

export interface AuthScreen {
  el: HTMLElement;
  setStatus(status: AuthStatus): void;
  setError(message: string): void;
  setBusy(busy: boolean): void;
}

const KEY_ICON = '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>';

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function passkeySupport(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && "credentials" in navigator;
}

export function createAuthScreen(api: ApiClient, onAuthenticated: () => void): AuthScreen {
  const supported = passkeySupport();
  let configured = false;
  let mode: AuthStatus["mode"] = "passkey";
  let statusText = h("p", { class: "auth__status", role: "status", "aria-live": "polite" }, "Проверяю passkey…");
  const ownerInput = h("input", {
    class: "input",
    id: "owner-name",
    name: "owner",
    type: "text",
    autocomplete: "name",
    placeholder: "Ваше имя",
    maxlength: "64",
    required: true,
  }) as HTMLInputElement;
  const passwordInput = h("input", { class: "input", id: "panel-password", name: "password", type: "password", autocomplete: "current-password", placeholder: "Пароль" }) as HTMLInputElement;
  const passwordField = h("div", { class: "field", hidden: true }, h("label", { class: "field__label", for: "panel-password" }, "Пароль"), passwordInput);
  const submit = h("button", { class: "button button--primary", type: "submit", disabled: true }, svgIcon(KEY_ICON), "Продолжить") as HTMLButtonElement;
  const form = h("form", { class: "auth__form", novalidate: true, onsubmit: (event: Event) => { event.preventDefault(); void authenticate(); } },
    h("div", { class: "field", id: "owner-field" }, h("label", { class: "field__label", for: "owner-name" }, "Имя владельца"), ownerInput),
    passwordField,
    submit,
  );
  const title = h("h1", { class: "auth__title", id: "auth-title" }, "Добро пожаловать");
  const description = h("p", { class: "auth__description" }, "Доступ к панели управления защищён passkey.");
  const card = h("section", { class: "auth__card", "aria-labelledby": "auth-title" },
    h("div", { class: "auth__mark", "aria-hidden": "true" }, svgIcon(KEY_ICON)),
    title,
    description,
    form,
    statusText,
  );
  const brandName = h("span", { class: "brand__name" }, "Станция");
  const footnote = h("p", { class: "auth__footnote" }, "Passkey хранится в вашем браузере или менеджере ключей. Пароли не используются.");
  const el = h("main", { class: "auth" },
    h("div", { class: "brand" }, brandName, h("span", { class: "brand__rule" }), h("span", {}, "панель управления")),
    card,
    footnote,
  );

  function setStatus(status: AuthStatus): void {
    configured = status.configured;
    mode = status.mode ?? "passkey";
    brandName.textContent = status.name || "Станция";
    if (mode === "password") {
      title.textContent = "Войти в панель";
      description.textContent = "Введите пароль панели.";
      (ownerInput.parentElement as HTMLElement).hidden = true;
      ownerInput.required = false;
      passwordField.hidden = false;
      submit.textContent = "";
      submit.append(svgIcon(KEY_ICON), "Войти");
      submit.disabled = false;
      statusText.textContent = "";
      footnote.textContent = "Пароль задаётся на станции: PANEL_PASSWORD в panel.env.";
      passwordInput.focus();
      return;
    }
    title.textContent = configured ? "Войти в панель" : "Настроить доступ";
    description.textContent = configured
      ? "Подтвердите passkey, чтобы открыть панель управления."
      : "Создайте первый passkey. Он станет единственным ключом владельца.";
    ownerInput.hidden = configured;
    ownerInput.disabled = configured;
    ownerInput.required = !configured;
    (ownerInput.parentElement as HTMLElement).hidden = configured;
    submit.textContent = "";
    submit.append(svgIcon(KEY_ICON), configured ? "Войти с passkey" : "Создать passkey");
    submit.disabled = !supported;
    statusText.textContent = supported ? "" : window.isSecureContext ? "Этот браузер не поддерживает passkey." : "Passkey работает только по HTTPS: откройте панель через https:// или включите PANEL_AUTH=password.";
  }

  function setError(message: string): void {
    statusText.textContent = message;
    statusText.dataset.error = "true";
  }

  function setBusy(busy: boolean): void {
    submit.disabled = busy || !supported;
    submit.dataset.busy = busy ? "true" : "false";
    statusText.textContent = busy ? "Ожидаю подтверждение passkey…" : "";
    statusText.dataset.error = "false";
  }

  async function authenticate(): Promise<void> {
    if (mode === "password") {
      if (!passwordInput.value) { passwordInput.focus(); return; }
      submit.disabled = true;
      statusText.dataset.error = "false";
      statusText.textContent = "Проверяю…";
      try {
        const result = await api.passwordLogin(passwordInput.value);
        session.set(result.session);
        onAuthenticated();
      } catch (error) {
        submit.disabled = false;
        passwordInput.select();
        setError(error instanceof ApiRequestError && error.status === 429 ? "Слишком много попыток, подождите 30 секунд." : error instanceof ApiRequestError && error.status === 401 ? "Неверный пароль." : "Не удалось войти.");
      }
      return;
    }
    if (!supported) return;
    setBusy(true);
    try {
      if (configured) {
        const options = await api.loginOptions();
        const credential = await navigator.credentials.get({ publicKey: {
          challenge: base64UrlToBytes(options.challenge) as unknown as BufferSource,
          rpId: options.rpId,
          userVerification: options.userVerification as UserVerificationRequirement,
        } }) as PublicKeyCredential | null;
        if (!credential) throw new Error("Вход отменён.");
        const response = credential.response as AuthenticatorAssertionResponse;
        const result = await api.loginVerify({
          credentialId: bytesToBase64Url(credential.rawId),
          authenticatorData: bytesToBase64Url(response.authenticatorData),
          clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
          signature: bytesToBase64Url(response.signature),
        });
        session.set(result.session);
      } else {
        const owner = ownerInput.value.trim();
        if (!owner) {
          ownerInput.focus();
          throw new Error("Введите имя владельца.");
        }
        const options = await api.registrationOptions(owner);
        const credential = await navigator.credentials.create({ publicKey: {
          challenge: base64UrlToBytes(options.challenge) as unknown as BufferSource,
          rp: options.rp,
          user: { id: base64UrlToBytes(options.user.id) as unknown as BufferSource, name: options.user.name, displayName: options.user.displayName },
          pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
          authenticatorSelection: options.authenticatorSelection as AuthenticatorSelectionCriteria,
          attestation: options.attestation as AttestationConveyancePreference,
        } }) as PublicKeyCredential | null;
        if (!credential) throw new Error("Создание passkey отменено.");
        const response = credential.response as AuthenticatorAttestationResponse;
        const result = await api.registrationVerify({
          owner,
          attestationObject: bytesToBase64Url(response.attestationObject),
          clientDataJSON: new TextDecoder().decode(response.clientDataJSON),
        });
        session.set(result.session);
      }
      onAuthenticated();
    } catch (error) {
      setBusy(false);
      setError(error instanceof Error ? error.message : "Не удалось подтвердить passkey.");
    }
  }

  return { el, setStatus, setError, setBusy };
}
