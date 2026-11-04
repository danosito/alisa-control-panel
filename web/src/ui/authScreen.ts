import type { ApiClient } from "../api/client";
import { clearPairingFromUrl, createPasskey, deviceLabel, formatCode, PasskeyExistsError, passkeyErrorMessage, passkeyUsable, signInWithPasskey } from "../api/passkeys";
import { session } from "../api/storage";
import type { AuthStatus } from "../api/types";
import { h, svgIcon } from "./dom";

export interface AuthScreen {
  el: HTMLElement;
  setStatus(status: AuthStatus): void;
  setError(message: string): void;
}

const KEY_ICON = '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>';
const DEVICE_ICON = '<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>';
const LOCK_ICON = '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>';

/** "signin": existing methods; "setup": the very first one; "pair": new device with a code. */
type View = "signin" | "setup" | "pair";
type Method = "passkey" | "password";

export function createAuthScreen(api: ApiClient, onAuthenticated: () => void, options: { pairingCode?: string | null } = {}): AuthScreen {
  let view: View = options.pairingCode ? "pair" : "signin";
  let status: AuthStatus = { configured: true, owner: "", name: "Станция", passkey_ready: false, origin: "", passkeys: 0, passwords: 0 };
  let method: Method = "password";
  let busy = false;

  const input = (attrs: Record<string, unknown>) => h("input", { class: "input", type: "text", ...attrs }) as HTMLInputElement;
  const field = (id: string, label: string, control: HTMLElement) => h("div", { class: "field" }, h("label", { class: "field__label", for: id }, label), control);
  const ownerInput = input({ id: "owner-name", name: "owner", autocomplete: "name", placeholder: "Ваше имя", maxlength: "64" });
  const codeInput = input({ id: "pair-code", name: "code", autocomplete: "one-time-code", placeholder: "K7Q2-MX4D", maxlength: "9", spellcheck: "false", autocapitalize: "characters", value: options.pairingCode ? formatCode(options.pairingCode) : "" });
  const nameInput = input({ id: "device-name", name: "device", placeholder: "Например, Ноутбук · Chrome", maxlength: "64" });
  const passwordInput = input({ id: "panel-password", name: "password", type: "password", placeholder: "Пароль" });
  const repeatInput = input({ id: "panel-password-repeat", name: "password-repeat", type: "password", autocomplete: "new-password", placeholder: "Ещё раз" });
  void deviceLabel().then((label) => { if (!nameInput.value) nameInput.value = label; });

  const ownerField = field("owner-name", "Имя владельца", ownerInput);
  const codeField = field("pair-code", "Код подключения", codeInput);
  const nameField = field("device-name", "Название устройства", nameInput);
  const passwordLabel = h("label", { class: "field__label", for: "panel-password" }, "Пароль");
  const passwordField = h("div", { class: "field" }, passwordLabel, passwordInput);
  const repeatField = field("panel-password-repeat", "Повторите пароль", repeatInput);
  const methodButtons = (["passkey", "password"] as const).map((m) => h("button", { type: "button", class: "auth__method", "data-method": m, onclick: () => { method = m; render(); } }, m === "passkey" ? "Passkey" : "Пароль") as HTMLButtonElement);
  const methodField = h("div", { class: "field" }, h("span", { class: "field__label" }, "Как входить с этого устройства"), h("div", { class: "auth__methods", role: "radiogroup" }, ...methodButtons));
  const submit = h("button", { class: "button button--primary", type: "submit" }) as HTMLButtonElement;
  const form = h("form", { class: "auth__form", novalidate: true, onsubmit: (event: Event) => { event.preventDefault(); void submitForm(); } },
    ownerField, codeField, methodField, nameField, passwordField, repeatField, submit);
  const passkeyButton = h("button", { class: "button button--primary auth__passkey", type: "button", onclick: () => void withPasskey() }, svgIcon(KEY_ICON), "Войти с passkey") as HTMLButtonElement;
  const divider = h("div", { class: "auth__or" }, h("span", {}, "или паролем"));
  const hint = h("p", { class: "auth__hint" });
  const statusText = h("p", { class: "auth__status", role: "status", "aria-live": "polite" });
  const switchLink = h("button", { class: "auth__switch", type: "button", onclick: () => { view = view === "pair" ? "signin" : "pair"; render(); focusFirst(); } }) as HTMLButtonElement;
  const mark = h("div", { class: "auth__mark", "aria-hidden": "true" });
  const title = h("h1", { class: "auth__title", id: "auth-title" });
  const description = h("p", { class: "auth__description" });
  const card = h("section", { class: "auth__card", "aria-labelledby": "auth-title" }, mark, title, description, passkeyButton, divider, form, hint, statusText, switchLink);
  const brandName = h("span", { class: "brand__name" }, "Станция");
  const footnote = h("p", { class: "auth__footnote" });
  const el = h("main", { class: "auth" },
    h("div", { class: "brand" }, brandName, h("span", { class: "brand__rule" }), h("span", {}, "панель управления")),
    card,
    footnote,
  );

  const usable = () => passkeyUsable(status);

  function render(): void {
    const creating = view !== "signin";
    if (creating && method === "passkey" && !usable()) method = "password";
    const signinPasskey = view === "signin" && usable() && status.passkeys > 0;
    const signinPassword = view === "signin" && status.passwords > 0;
    ownerField.hidden = view !== "setup";
    codeField.hidden = view !== "pair" || Boolean(options.pairingCode);
    methodField.hidden = !creating || !usable();
    nameField.hidden = !creating;
    passwordField.hidden = creating ? method !== "password" : !signinPassword;
    repeatField.hidden = !creating || method !== "password";
    form.hidden = view === "signin" && !signinPassword;
    passkeyButton.hidden = !signinPasskey;
    divider.hidden = !(signinPasskey && signinPassword);
    passwordInput.autocomplete = creating ? "new-password" : "current-password";
    // One primary action: the passkey button when it is offered.
    submit.classList.toggle("button--primary", !signinPasskey);
    passwordLabel.textContent = creating ? "Новый пароль (от 8 символов)" : "Пароль";
    for (const b of methodButtons) { const on = b.dataset.method === method; b.classList.toggle("auth__method--active", on); b.setAttribute("aria-checked", String(on)); b.setAttribute("role", "radio"); }
    mark.replaceChildren(svgIcon(view === "pair" ? DEVICE_ICON : view === "signin" ? KEY_ICON : LOCK_ICON));
    title.textContent = { signin: "Войти в панель", setup: "Настроить доступ", pair: "Подключить устройство" }[view];
    description.textContent = view === "signin"
      ? signinPasskey || signinPassword ? "Подтвердите вход с этого устройства." : "Этим устройством пока не войти: подключите его по коду."
      : view === "setup" ? "Выберите, как входить с этого устройства. Другие устройства подключите потом — по QR-коду, каждое своим способом."
      : options.pairingCode ? "Выберите, как это устройство будет входить: passkey или свой пароль." : "На подключённом устройстве: профиль → «Устройства и входы» → «Подключить устройство». Введите код оттуда.";
    submit.replaceChildren(svgIcon(creating && method === "passkey" ? KEY_ICON : LOCK_ICON),
      view === "signin" ? "Войти" : method === "passkey" ? "Создать passkey и войти" : "Сохранить пароль и войти");
    // Passkeys exist, but they cannot work on this address.
    const elsewhere = view === "signin" && status.passkeys > 0 && status.passkey_ready && !usable() && status.origin && status.origin !== location.origin;
    hint.textContent = elsewhere ? `Passkey работают только на ${status.origin.replace(/^https:\/\//, "")}. Здесь — по паролю или подключите устройство по коду.` : "";
    hint.hidden = !hint.textContent;
    switchLink.hidden = !status.configured;
    switchLink.textContent = view === "pair" ? "Это устройство уже подключено — войти" : "Новое устройство? Подключить по коду";
    footnote.textContent = view === "pair" ? "Код действует 10 минут и подходит один раз." : "Способы входа можно сочетать: на одних устройствах passkey, на других — пароль.";
    submit.disabled = busy;
    passkeyButton.disabled = busy;
  }

  function focusFirst(): void {
    (view === "setup" ? ownerInput : view === "pair" && !options.pairingCode ? codeInput : !passwordField.hidden ? passwordInput : null)?.focus();
  }

  function setStatus(next: AuthStatus): void {
    status = next;
    brandName.textContent = next.name || "Станция";
    if (!next.configured) view = "setup";
    else if (view === "setup") view = "signin";
    method = usable() ? "passkey" : "password";
    render();
    focusFirst();
  }

  function setError(message: string): void {
    statusText.textContent = message;
    statusText.dataset.error = "true";
  }

  function setBusy(next: boolean, message = ""): void {
    busy = next;
    statusText.dataset.error = "false";
    statusText.textContent = message;
    render();
  }

  function done(token: string): void {
    session.set(token);
    clearPairingFromUrl();
    onAuthenticated();
  }

  async function withPasskey(): Promise<void> {
    setBusy(true, "Ожидаю подтверждение passkey…");
    try { done(await signInWithPasskey(api)); }
    catch (error) { setBusy(false); setError(passkeyErrorMessage(error)); }
  }

  async function submitForm(): Promise<void> {
    if (busy) return;
    if (view === "signin") {
      if (!passwordInput.value) { passwordInput.focus(); return; }
      setBusy(true, "Проверяю…");
      try { done((await api.passwordLogin(passwordInput.value, await deviceLabel())).session); }
      catch (error) { setBusy(false); passwordInput.select(); setError(passkeyErrorMessage(error)); }
      return;
    }
    if (view === "setup" && !ownerInput.value.trim()) { ownerInput.focus(); setError("Введите имя владельца."); return; }
    const code = (options.pairingCode ?? codeInput.value).replace(/[\s-]/g, "").toUpperCase();
    if (view === "pair" && code.length !== 8) { codeInput.focus(); setError("Код — 8 символов, например K7Q2-MX4D."); return; }
    const grant = view === "setup" ? { owner: ownerInput.value.trim() } : { invite: code };
    const name = nameInput.value.trim() || await deviceLabel();
    if (method === "password") {
      if ([...passwordInput.value].length < 8) { passwordInput.focus(); setError("Пароль — минимум 8 символов."); return; }
      if (passwordInput.value !== repeatInput.value) { repeatInput.select(); setError("Пароли не совпадают."); return; }
      setBusy(true, "Сохраняю пароль…");
      try {
        const result = await api.passwordCreate({ ...grant, name, password: passwordInput.value, device: name });
        if (!result.session) throw new Error("Сервер не открыл сеанс.");
        done(result.session);
      } catch (error) { setBusy(false); setError(passkeyErrorMessage(error)); }
      return;
    }
    setBusy(true, "Ожидаю подтверждение passkey…");
    try {
      try {
        done(await createPasskey(api, { ...grant, name }));
      } catch (error) {
        // A synced key (iCloud, Google) is already here: just use it.
        if (!(error instanceof PasskeyExistsError)) throw error;
        setBusy(true, "На этом устройстве уже есть ключ панели — вхожу им…");
        done(await signInWithPasskey(api));
      }
    } catch (error) { setBusy(false); setError(passkeyErrorMessage(error)); }
  }

  render();
  return { el, setStatus, setError };
}
