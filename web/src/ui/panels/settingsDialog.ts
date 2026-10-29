import type { AnyWidget, GridSize, WidgetConfig } from "../../widgets/types";
import { h } from "../dom";

export interface SettingsResult { config: WidgetConfig; size?: GridSize }

/** Opens a modal generated from the widget's configSchema. Resolves null on cancel. */
export function openWidgetSettings(definition: AnyWidget, config: WidgetConfig, size: GridSize): Promise<SettingsResult | null> {
  return new Promise((resolve) => {
    const values: WidgetConfig = { ...definition.defaultConfig, ...config };
    let chosenSize: GridSize | undefined;
    const sizeButtons = definition.sizes.map((preset: GridSize) => {
      const button = h("button", { type: "button", class: `settings__size ${preset.w === size.w && preset.h === size.h ? "settings__size--active" : ""}` }, `${preset.w}×${preset.h}`);
      button.addEventListener("click", () => { chosenSize = preset; for (const b of sizeButtons) b.classList.toggle("settings__size--active", b === button); });
      return button;
    });
    const fields = definition.configSchema.map((field) => {
      const id = `cfg-${field.key}`;
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (field.type === "select") {
        input = h("select", { id }, ...field.options.map((o) => h("option", { value: o.value, selected: String(values[field.key]) === o.value }, o.label))) as HTMLSelectElement;
        input.addEventListener("change", () => { values[field.key] = (input as HTMLSelectElement).value; });
      } else if (field.type === "checkbox") {
        input = h("input", { id, type: "checkbox", checked: Boolean(values[field.key]) }) as HTMLInputElement;
        input.addEventListener("change", () => { values[field.key] = (input as HTMLInputElement).checked; });
        return h("label", { class: "settings__check", for: id }, input, h("span", {}, field.label));
      } else if (field.type === "textarea") {
        input = h("textarea", { id, rows: "3", placeholder: field.placeholder ?? "" }) as HTMLTextAreaElement;
        input.value = String(values[field.key] ?? "");
        input.addEventListener("input", () => { values[field.key] = (input as HTMLTextAreaElement).value; });
      } else if (field.type === "number") {
        input = h("input", { id, type: "number", min: field.min, max: field.max, step: field.step, value: String(values[field.key] ?? "") }) as HTMLInputElement;
        input.addEventListener("input", () => { values[field.key] = Number((input as HTMLInputElement).value); });
      } else {
        input = h("input", { id, type: "text", placeholder: field.placeholder ?? "", value: String(values[field.key] ?? "") }) as HTMLInputElement;
        input.addEventListener("input", () => { values[field.key] = (input as HTMLInputElement).value; });
      }
      return h("label", { class: "settings__field", for: id }, h("span", {}, field.label), input);
    });
    const dialog = h("dialog", { class: "settings" },
      h("form", { method: "dialog", class: "settings__form" },
        h("header", { class: "settings__head" }, h("strong", {}, definition.title), h("span", {}, definition.description)),
        h("div", { class: "settings__group" }, h("span", { class: "settings__label" }, "Размер"), h("div", { class: "settings__sizes" }, sizeButtons)),
        fields.length ? h("div", { class: "settings__group" }, fields) : h("p", { class: "settings__empty" }, "У этого виджета нет настроек."),
        h("footer", { class: "settings__actions" },
          h("button", { type: "button", class: "w-btn", value: "cancel", onclick: () => close(null) }, "Отмена"),
          h("button", { type: "submit", class: "w-btn w-btn--active", value: "save" }, "Сохранить"),
        ),
      ),
    ) as HTMLDialogElement;
    const close = (result: SettingsResult | null) => { dialog.close(); dialog.remove(); resolve(result); };
    dialog.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); close({ config: values, ...(chosenSize ? { size: chosenSize } : {}) }); });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(null); });
    document.body.append(dialog);
    dialog.showModal();
  });
}
