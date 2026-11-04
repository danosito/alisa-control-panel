// "Устройства и ключи": passkeys of every device, signed-in browsers, and
// pairing of a new device by QR code / link / 8-character code.
import { encode } from "uqr";
import type { ApiClient } from "../api/client";
import { createPasskey, deviceLabel, formatCode, PasskeyExistsError, passkeyErrorMessage, pairingLink, passkeysSupported } from "../api/passkeys";
import type { AuthDevices, InviteInfo, PasskeyInfo, SessionInfo } from "../api/types";
import { h } from "./dom";

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
  let knownKeys = new Set<string>();
  let joined = "";
  let poll: number | undefined;
  let tick: number | undefined;

  const status = h("p", { class: "devices__status", role: "status", "aria-live": "polite" });
  const pairing = h("section", { class: "devices__pairing" });
  const keys = h("section", { class: "devices__section" });
  const sessions = h("section", { class: "devices__section" });
  const dialog = h("dialog", { class: "settings devices" },
    h("div", { class: "settings__form" },
      h("header", { class: "settings__head devices__head" },
        h("strong", {}, "Устройства и ключи"),
        h("button", { type: "button", class: "devices__close", "aria-label": "Закрыть", onclick: () => close() }, "✕")),
      pairing, status, keys, sessions),
  ) as HTMLDialogElement;

  const say = (text: string, error = false) => { status.textContent = text; status.dataset.error = String(error); };

  async function load(): Promise<void> {
    try {
      const next = await api.devices();
      const fresh = next.passkeys.filter((p) => !knownKeys.has(p.id));
      if (state && fresh.length > 0) {
        joined = fresh.map((p) => p.name).join(", ");
        invite = null;
      }
      knownKeys = new Set(next.passkeys.map((p) => p.id));
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

  function renderPairing(): void {
    if (!state || state.mode !== "passkey") { pairing.replaceChildren(); return; }
    if (joined) {
      pairing.replaceChildren(h("div", { class: "devices__joined" }, h("strong", {}, "Подключено"), h("span", {}, joined)),
        h("div", { class: "devices__actions" }, h("button", { type: "button", class: "w-btn", onclick: () => { joined = ""; render(); } }, "Готово")));
      return;
    }
    if (!invite) {
      pairing.replaceChildren(h("div", { class: "devices__actions" },
        h("button", { type: "button", class: "w-btn w-btn--active", onclick: () => void startInvite() }, "＋ Подключить устройство"),
        passkeysSupported() ? h("button", { type: "button", class: "w-btn", title: "Например, второй менеджер паролей или аппаратный ключ", onclick: () => void addKeyHere() }, "Ещё ключ на этом") : null));
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
        h("span", {}, "или введите код на экране входа:"),
        h("strong", { class: "devices__code" }, formatCode(invite.code)),
        h("span", { class: "devices__hint" }, "Действует ", left, " и подходит один раз."),
        h("div", { class: "devices__actions" },
          h("button", { type: "button", class: "w-btn", onclick: () => { void navigator.clipboard?.writeText(link).then(() => say("Ссылка скопирована.")); } }, "Скопировать ссылку"),
          h("button", { type: "button", class: "w-btn", onclick: () => { void api.cancelInvite(); invite = null; render(); } }, "Отменить")))));
  }

  function keyRow(p: PasskeyInfo, now: number, only: boolean): HTMLElement {
    const name = h("input", { class: "devices__name", value: p.name, maxlength: "64", "aria-label": "Название ключа", title: "Нажмите, чтобы переименовать" }) as HTMLInputElement;
    const save = async () => {
      const value = name.value.trim();
      if (!value || value === p.name) { name.value = p.name; return; }
      try { await api.renamePasskey(p.id, value); p.name = value; say("Переименовано."); } catch (error) { name.value = p.name; say(passkeyErrorMessage(error), true); }
    };
    name.addEventListener("change", () => void save());
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); if (e.key === "Escape") { name.value = p.name; name.blur(); e.stopPropagation(); } });
    const meta = [p.provider, p.last_used_s ? `вход ${ago(p.last_used_s, now)}` : `создан ${ago(p.created_s, now)}`, p.sessions ? plural(p.sessions, "сеанс", "сеанса", "сеансов") : "нет сеансов"].filter(Boolean).join(" · ");
    const remove = h("button", { type: "button", class: "devices__remove", disabled: only, title: only ? "Последний ключ удалить нельзя" : "Удалить ключ", "aria-label": `Удалить ключ ${p.name}`, onclick: async () => {
      const warn = p.current ? "Это ключ, которым вы вошли сейчас: это устройство тоже выйдет." : `Устройства с этим ключом выйдут (${plural(p.sessions, "сеанс", "сеанса", "сеансов")}).`;
      if (!confirm(`Удалить ключ «${p.name}»? ${warn}\n\nСам passkey останется в менеджере паролей — удалите его там вручную.`)) return;
      try {
        const result = await api.removePasskey(p.id);
        if (result.signed_out) { close(); options.onSignedOut(); return; }
        await load();
      } catch (error) { say(passkeyErrorMessage(error), true); }
    } }, "✕");
    return h("li", { class: `devices__row ${p.current ? "devices__row--current" : ""}` },
      h("div", { class: "devices__main" }, name, h("span", { class: "devices__meta" }, meta)),
      p.current ? h("span", { class: "devices__badge" }, "этот") : null,
      remove);
  }

  function sessionRow(s: SessionInfo, now: number): HTMLElement {
    const meta = [s.current ? "сейчас" : ago(s.last_seen_s, now), s.passkey ? `ключ «${s.passkey}»` : ""].filter(Boolean).join(" · ");
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
    if (state.mode === "passkey") {
      keys.replaceChildren(h("span", { class: "settings__label" }, "Ключи"),
        h("ul", { class: "devices__list" }, ...state.passkeys.map((p) => keyRow(p, now, state!.passkeys.length <= 1))));
    } else keys.replaceChildren();
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
