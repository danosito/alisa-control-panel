import { ApiRequestError, type ApiClient } from "../api/client";
import { clearPairingFromUrl, createPasskey, deviceLabel, formatCode, PasskeyExistsError, passkeyErrorMessage, passkeysSupported, signInWithPasskey } from "../api/passkeys";
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
const DEVICE_ICON = '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>';

/** "signin": existing key; "setup": the very first key; "pair": new device with a code. */
type View = "signin" | "setup" | "pair" | "password";

export function createAuthScreen(api: ApiClient, onAuthenticated: () => void, options: { pairingCode?: string | null } = {}): AuthScreen {
  const supported = passkeysSupported();
  let view: View = options.pairingCode ? "pair" : "signin";
  let configured = false;
  const statusText = h("p", { class: "auth__status", role: "status", "aria-live": "polite" }, "Проверяю…");
  const input = (attrs: Record<string, unknown>) => h("input", { class: "input", type: "text", ...attrs }) as HTMLInputElement;
  const field = (id: string, label: string, control: HTMLElement) => h("div", { class: "field" }, h("label", { class: "field__label", for: id }, label), control);

  const ownerInput = input({ id: "owner-name", name: "owner", autocomplete: "name", placeholder: "Ваше имя", maxlength: "64" });
  const codeInput = input({ id: "pair-code", name: "code", autocomplete: "one-time-code", placeholder: "K7Q2-MX4D", maxlength: "9", spellcheck: "false", autocapitalize: "characters", value: options.pairingCode ? formatCode(options.pairingCode) : "" });
  const nameInput = input({ id: "device-name", name: "device", placeholder: "Например, iPhone · Safari", maxlength: "64" });
  const passwordInput = input({ id: "panel-password", name: "password", type: "password", autocomplete: "current-password", placeholder: "Пароль" });
  void deviceLabel().then((label) => { if (!nameInput.value) nameInput.value = label; });

  const ownerField = field("owner-name", "Имя владельца", ownerInput);
  const codeField = field("pair-code", "Код подключения", codeInput);
  const nameField = field("device-name", "Название устройства", nameInput);
  const passwordField = field("panel-password", "Пароль", passwordInput);
  const submit = h("button", { class: "button button--primary", type: "submit", disabled: true }) as HTMLButtonElement;
  const switchLink = h("button", { class: "auth__switch", type: "button", onclick: () => { setView(view === "pair" ? "signin" : "pair"); } }) as HTMLButtonElement;
  const form = h("form", { class: "auth__form", novalidate: true, onsubmit: (event: Event) => { event.preventDefault(); void submitForm(); } },
    ownerField, codeField, nameField, passwordField, submit);
  const mark = h("div", { class: "auth__mark", "aria-hidden": "true" }, svgIcon(KEY_ICON));
  const title = h("h1", { class: "auth__title", id: "auth-title" }, "Добро пожаловать");
  const description = h("p", { class: "auth__description" }, "");
  const card = h("section", { class: "auth__card", "aria-labelledby": "auth-title" }, mark, title, description, form, statusText, switchLink);
  const brandName = h("span", { class: "brand__name" }, "Станция");
  const footnote = h("p", { class: "auth__footnote" }, "");
  const el = h("main", { class: "auth" },
    h("div", { class: "brand" }, brandName, h("span", { class: "brand__rule" }), h("span", {}, "панель управления")),
    card,
    footnote,
  );

  function setView(next: View): void {
    view = next;
    ownerField.hidden = view !== "setup";
    codeField.hidden = view !== "pair";
    nameField.hidden = view !== "pair" && view !== "setup";
    passwordField.hidden = view !== "password";
    switchLink.hidden = !(configured && supported && (view === "signin" || view === "pair"));
    switchLink.textContent = view === "pair" ? "У меня уже есть ключ — войти" : "Новое устройство? Подключить по коду";
    mark.replaceChildren(svgIcon(view === "pair" ? DEVICE_ICON : KEY_ICON));
    const [heading, text, button, note] = ({
      signin: ["Войти в панель", "Подтвердите вход ключом этого устройства.", "Войти с passkey", "Ключ хранится на устройстве или в менеджере паролей. Пароли не нужны."],
      setup: ["Настроить доступ", "Создайте первый ключ. Другие устройства подключите потом — по QR-коду с этого.", "Создать passkey", "Ключ хранится на устройстве или в менеджере паролей. Пароли не нужны."],
      pair: ["Подключить устройство", "На уже подключённом устройстве откройте профиль → «Устройства и ключи» → «Подключить устройство» и введите код.", "Создать ключ и войти", "Код действует 10 минут и подходит один раз."],
      password: ["Войти в панель", "Введите пароль панели.", "Войти", "Пароль задаётся на станции: PANEL_PASSWORD в panel.env."],
    } as const)[view];
    title.textContent = heading;
    description.textContent = view === "pair" && options.pairingCode ? "Создайте ключ на этом устройстве — дальше оно будет входить само." : text;
    if (view === "pair" && options.pairingCode) codeField.hidden = true;
    submit.replaceChildren(svgIcon(KEY_ICON), button);
    footnote.textContent = note;
    statusText.dataset.error = "false";
    statusText.textContent = view !== "password" && !supported
      ? window.isSecureContext ? "Этот браузер не поддерживает passkey." : "Passkey работает только по HTTPS: откройте панель через https:// или включите PANEL_AUTH=password."
      : "";
    submit.disabled = view !== "password" && !supported;
    (view === "setup" ? ownerInput : view === "pair" && !options.pairingCode ? codeInput : view === "password" ? passwordInput : null)?.focus();
  }

  function setStatus(status: AuthStatus): void {
    configured = status.configured;
    brandName.textContent = status.name || "Станция";
    if (status.mode === "password") return setView("password");
    if (!configured) return setView("setup");
    setView(view === "pair" ? "pair" : "signin");
  }

  function setError(message: string): void {
    statusText.textContent = message;
    statusText.dataset.error = "true";
  }

  function setBusy(busy: boolean, message = "Ожидаю подтверждение passkey…"): void {
    submit.disabled = busy || (view !== "password" && !supported);
    submit.dataset.busy = busy ? "true" : "false";
    statusText.dataset.error = "false";
    statusText.textContent = busy ? message : "";
  }

  function done(token: string): void {
    session.set(token);
    clearPairingFromUrl();
    onAuthenticated();
  }

  async function submitForm(): Promise<void> {
    if (view === "password") {
      if (!passwordInput.value) { passwordInput.focus(); return; }
      setBusy(true, "Проверяю…");
      try {
        done((await api.passwordLogin(passwordInput.value, await deviceLabel())).session);
      } catch (error) {
        setBusy(false);
        passwordInput.select();
        setError(error instanceof ApiRequestError && error.status === 429 ? "Слишком много попыток, подождите 30 секунд." : error instanceof ApiRequestError && error.status === 401 ? "Неверный пароль." : "Не удалось войти.");
      }
      return;
    }
    if (!supported) return;
    if (view === "setup" && !ownerInput.value.trim()) { ownerInput.focus(); setError("Введите имя владельца."); return; }
    const code = (options.pairingCode ?? codeInput.value).replace(/[\s-]/g, "").toUpperCase();
    if (view === "pair" && code.length !== 8) { codeInput.focus(); setError("Код — 8 символов, например K7Q2-MX4D."); return; }
    setBusy(true);
    try {
      if (view === "signin") return done(await signInWithPasskey(api));
      const name = nameInput.value.trim() || await deviceLabel();
      try {
        done(await createPasskey(api, view === "setup" ? { owner: ownerInput.value.trim(), name } : { invite: code, name }));
      } catch (error) {
        // A synced key (iCloud, Google) is already here: just use it.
        if (!(error instanceof PasskeyExistsError)) throw error;
        setBusy(true, "На этом устройстве уже есть ключ панели — вхожу им…");
        done(await signInWithPasskey(api));
      }
    } catch (error) {
      setBusy(false);
      setError(passkeyErrorMessage(error));
      if (view === "signin" && !(error instanceof ApiRequestError)) switchLink.hidden = false;
    }
  }

  setView(view);
  return { el, setStatus, setError, setBusy };
}
