// "Устройства и входы": sign-in methods (passkeys and passwords, in any mix),
// signed-in browsers, and pairing of a new device by QR code / link / code —
// the new device then picks its own method.
import { encode } from "uqr";
import type { ApiClient } from "../api/client";
import { createPasskey, deviceLabel, formatCode, PasskeyExistsError, passkeyErrorMessage, pairingLink, passkeyUsable } from "../api/passkeys";
import type { AuthDevices, CredentialInfo, InviteInfo, SessionInfo } from "../api/types";
import { h, svgIcon } from "./dom";

const KEY_ICON = '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M21 12v2"/>';
const LOCK_ICON = '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>';

/**
 * QR on a canvas with a whole number of device pixels per module: SVG squares
 * at fractional scale get anti-aliased seams that phone cameras cannot read.
 */
function qrCanvas(text: string, cssSize: number): HTMLCanvasElement {
  const { data, size } = encode(text, { border: 4, ecc: "M" });
  const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const scale = Math.max(2, Math.floor((cssSize * dpr) / size));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size * scale;
  canvas.style.width = canvas.style.height = `${(size * scale) / dpr}px`;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#000";
  data.forEach((row, y) => row.forEach((dark, x) => { if (dark) g.fillRect(x * scale, y * scale, scale, scale); }));
  return canvas;
}

const relative = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" });

/** "только что", "5 минут назад", "вчера", "3 нояб." — against the server clock. */
function ago(t: number, now: number): string {
  if (t < 1_600_000_000) return "давно";
  const s = Math.max(0, now - t);
  if (s < 60) return "только что";
  if (s < 3600) return relative.format(-Math.round(s / 60), "minute");
  if (s < 86400) return relative.format(-Math.round(s / 3600), "hour");
  if (s < 7 * 86400) return relative.format(-Math.round(s / 86400), "day");
  return dateFormat.format(new Date(t * 1000));
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many}`;
};

export function openDevicesDialog(api: ApiClient, options: { onSignedOut: () => void }): void {
  let state: AuthDevices | null = null;
  let invite: (InviteInfo & { deadline: number }) | null = null;
  let known = new Set<string>();
  let joined = "";
  /** The "add a password on this device" form is open. */
  let adding = false;
  let poll: number | undefined;
  let tick: number | undefined;

  const status = h("p", { class: "devices__status", role: "status", "aria-live": "polite" });
  const pairing = h("section", { class: "devices__pairing" });
  const keys = h("section", { class: "devices__section" });
  const sessions = h("section", { class: "devices__section" });
  const dialog = h("dialog", { class: "settings devices" },
    h("div", { class: "settings__form" },
      h("header", { class: "settings__head devices__head" },
        h("strong", {}, "Устройства и входы"),
        h("button", { type: "button", class: "devices__close", "aria-label": "Закрыть", onclick: () => close() }, "✕")),
      pairing, status, keys, sessions),
  ) as HTMLDialogElement;

  const say = (text: string, error = false) => { status.textContent = text; status.dataset.error = String(error); };

  async function load(): Promise<void> {
    try {
      const next = await api.devices();
      const fresh = next.credentials.filter((c) => !known.has(c.id));
      if (state && invite && fresh.length > 0) {
        joined = fresh.map((c) => c.name).join(", ");
        invite = null;
      }
      known = new Set(next.credentials.map((c) => c.id));
      if (next.invite && !invite && !joined) invite = { ...next.invite, deadline: Date.now() + next.invite.expires_in_s * 1000 };
      if (!next.invite && invite && !joined) invite = null;
      state = next;
      render();
    } catch (error) {
      say(passkeyErrorMessage(error), true);
    }
  }

  async function startInvite(): Promise<void> {
    joined = "";
    try {
      const created = await api.invite();
      invite = { ...created, deadline: Date.now() + created.expires_in_s * 1000 };
      render();
    } catch (error) { say(passkeyErrorMessage(error), true); }
  }

  async function addKeyHere(): Promise<void> {
    say("Ожидаю подтверждение passkey…");
    try {
      await createPasskey(api, { name: await deviceLabel() });
      say("Ключ добавлен.");
      await load();
    } catch (error) {
      say(error instanceof PasskeyExistsError ? "На этом устройстве ключ уже есть." : passkeyErrorMessage(error), true);
    }
  }

  function passwordForm(): HTMLElement {
    const field = (label: string, control: HTMLElement) => h("label", { class: "devices__field" }, h("span", {}, label), control);
    const name = h("input", { class: "devices__input", maxlength: "64", placeholder: "Например, Ноутбук" }) as HTMLInputElement;
    const first = h("input", { class: "devices__input", type: "password", autocomplete: "new-password", placeholder: "От 8 символов" }) as HTMLInputElement;
    const second = h("input", { class: "devices__input", type: "password", autocomplete: "new-password" }) as HTMLInputElement;
    void deviceLabel().then((label) => { if (!name.value) name.value = label; });
    const save = h("button", { type: "submit", class: "w-btn w-btn--active" }, "Сохранить пароль") as HTMLButtonElement;
    const form = h("form", { class: "devices__form", onsubmit: async (event: Event) => {
      event.preventDefault();
      if ([...first.value].length < 8) { first.focus(); say("Пароль — минимум 8 символов.", true); return; }
      if (first.value !== second.value) { second.select(); say("Пароли не совпадают.", true); return; }
      save.disabled = true;
      say("Сохраняю…");
      try {
        await api.passwordCreate({ name: name.value.trim() || "Пароль", password: first.value, device: "" });
        adding = false;
        say("Пароль добавлен.");
        await load();
      } catch (error) { save.disabled = false; say(passkeyErrorMessage(error), true); }
    } },
      field("Название", name), field("Пароль", first), field("Ещё раз", second),
      h("div", { class: "devices__actions" }, save, h("button", { type: "button", class: "w-btn", onclick: () => { adding = false; say(""); render(); } }, "Отмена")));
    queueMicrotask(() => first.focus());
    return form;
  }

  function renderPairing(): void {
    if (!state) { pairing.replaceChildren(); return; }
    if (adding) { pairing.replaceChildren(passwordForm()); return; }
    if (joined) {
      pairing.replaceChildren(h("div", { class: "devices__joined" }, h("strong", {}, "Подключено"), h("span", {}, joined)),
        h("div", { class: "devices__actions" }, h("button", { type: "button", class: "w-btn", onclick: () => { joined = ""; render(); } }, "Готово")));
      return;
    }
    if (!invite) {
      pairing.replaceChildren(h("div", { class: "devices__actions" },
        h("button", { type: "button", class: "w-btn w-btn--active", title: "Новое устройство само выберет: passkey или пароль", onclick: () => void startInvite() }, "＋ Подключить устройство"),
        passkeyUsable({ passkey_ready: state.passkey_ready, origin: location.origin }) ? h("button", { type: "button", class: "w-btn", title: "Например, второй менеджер паролей или аппаратный ключ", onclick: () => void addKeyHere() }, "＋ Passkey") : null,
        h("button", { type: "button", class: "w-btn", title: "Пароль для входа с любого устройства", onclick: () => { adding = true; say(""); render(); } }, "＋ Пароль")));
      return;
    }
    const link = pairingLink(invite.code);
    const qr = h("div", { class: "devices__qr", role: "img", "aria-label": "QR-код ссылки подключения" }, qrCanvas(link, window.innerWidth <= 520 ? 176 : 152));
    const left = h("span", { class: "devices__timer" });
    const updateTimer = () => {
      const s = Math.max(0, Math.round((invite!.deadline - Date.now()) / 1000));
      left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      if (s === 0) { invite = null; render(); }
    };
    window.clearInterval(tick);
    tick = window.setInterval(updateTimer, 1000);
    updateTimer();
    pairing.replaceChildren(h("div", { class: "devices__invite" }, qr,
      h("div", { class: "devices__how" },
        h("span", {}, "Наведите камеру нового устройства или откройте ссылку:"),
        h("a", { class: "devices__link", href: link, target: "_blank", rel: "noopener" }, link.replace(/^https?:\/\//, "")),
        h("span", {}, "или введите код на экране входа. Там же выберите: passkey или пароль."),
        h("strong", { class: "devices__code" }, formatCode(invite.code)),
        h("span", { class: "devices__hint" }, "Действует ", left, " и подходит один раз."),
        h("div", { class: "devices__actions" },
          h("button", { type: "button", class: "w-btn", onclick: () => { void navigator.clipboard?.writeText(link).then(() => say("Ссылка скопирована.")); } }, "Скопировать ссылку"),
          h("button", { type: "button", class: "w-btn", onclick: () => { void api.cancelInvite(); invite = null; render(); } }, "Отменить")))));
  }

  function credentialRow(c: CredentialInfo, now: number): HTMLElement {
    const kind = c.type === "passkey" ? "passkey" : "пароль";
    const name = h("input", { class: "devices__name", value: c.name, maxlength: "64", "aria-label": `Название (${kind})`, title: "Нажмите, чтобы переименовать" }) as HTMLInputElement;
    const fixed = c.provider === "panel.env";
    name.readOnly = fixed;
    const save = async () => {
      const value = name.value.trim();
      if (!value || value === c.name) { name.value = c.name; return; }
      try { await api.renameCredential(c.id, value); c.name = value; say("Переименовано."); } catch (error) { name.value = c.name; say(passkeyErrorMessage(error), true); }
    };
    name.addEventListener("change", () => void save());
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); if (e.key === "Escape") { name.value = c.name; name.blur(); e.stopPropagation(); } });
    const used = c.last_used_s ? `вход ${ago(c.last_used_s, now)}` : c.created_s ? `создан ${ago(c.created_s, now)}` : "";
    const meta = [kind, fixed ? "задан в panel.env" : c.provider, used, c.sessions ? plural(c.sessions, "сеанс", "сеанса", "сеансов") : "нет сеансов"].filter(Boolean).join(" · ");
    const remove = h("button", { type: "button", class: "devices__remove", disabled: !c.removable, title: fixed ? "Меняется в panel.env на станции" : c.removable ? "Удалить" : "Последний способ входа удалить нельзя", "aria-label": `Удалить ${kind} ${c.name}`, onclick: async () => {
      const warn = c.current ? "Вы вошли именно им: это устройство тоже выйдет." : `Устройства, вошедшие им, выйдут (${plural(c.sessions, "сеанс", "сеанса", "сеансов")}).`;
      const tail = c.type === "passkey" ? "\n\nСам passkey останется в менеджере паролей — удалите его там вручную." : "";
      if (!confirm(`Удалить ${kind} «${c.name}»? ${warn}${tail}`)) return;
      try {
        const result = await api.removeCredential(c.id);
        if (result.signed_out) { close(); options.onSignedOut(); return; }
        await load();
      } catch (error) { say(passkeyErrorMessage(error), true); }
    } }, "✕");
    return h("li", { class: `devices__row ${c.current ? "devices__row--current" : ""}` },
      h("span", { class: "devices__kind", title: kind }, svgIcon(c.type === "passkey" ? KEY_ICON : LOCK_ICON)),
      h("div", { class: "devices__main" }, name, h("span", { class: "devices__meta" }, meta)),
      c.current ? h("span", { class: "devices__badge" }, "этот") : null,
      remove);
  }

  function sessionRow(s: SessionInfo, now: number): HTMLElement {
    const meta = [s.current ? "сейчас" : ago(s.last_seen_s, now), s.credential ? `через «${s.credential}»` : ""].filter(Boolean).join(" · ");
    return h("li", { class: `devices__row ${s.current ? "devices__row--current" : ""}` },
      h("div", { class: "devices__main" }, h("span", { class: "devices__label" }, s.label), h("span", { class: "devices__meta" }, meta)),
      s.current ? h("span", { class: "devices__badge" }, "этот") : h("button", { type: "button", class: "w-btn devices__signout", onclick: async () => {
        try { await api.revokeSessions(s.id); await load(); } catch (error) { say(passkeyErrorMessage(error), true); }
      } }, "Выйти"));
  }

  function render(): void {
    renderPairing();
    if (!state) return;
    const now = state.now_s;
    keys.replaceChildren(h("span", { class: "settings__label" }, "Способы входа"),
      h("ul", { class: "devices__list" }, ...state.credentials.map((c) => credentialRow(c, now))));
    const others = state.sessions.filter((s) => !s.current).length;
    const ordered = [...state.sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_s - a.last_seen_s);
    const signOutOthers = h("div", { class: "devices__actions" }, h("button", { type: "button", class: "w-btn", onclick: async () => {
      if (!confirm(`Выйти на всех других устройствах (${others})?`)) return;
      try { await api.revokeSessions(); await load(); } catch (error) { say(passkeyErrorMessage(error), true); }
    } }, "Выйти на всех других"));
    sessions.replaceChildren(h("span", { class: "settings__label" }, "Где выполнен вход"),
      h("ul", { class: "devices__list" }, ...ordered.map((s) => sessionRow(s, now))),
      ...(others > 0 ? [signOutOthers] : []));
  }

  function close(): void {
    window.clearInterval(poll);
    window.clearInterval(tick);
    dialog.close();
    dialog.remove();
  }

  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  document.body.append(dialog);
  dialog.showModal();
  void load();
  // While a code is out, watch for the new device to appear.
  poll = window.setInterval(() => { if (invite && document.visibilityState === "visible") void load(); }, 2000);
}
