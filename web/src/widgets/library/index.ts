// The widget library. To add a widget: create a module next to this file and
// register it here. Order defines the catalog order.
import { registerWidget } from "../registry";
import { bluetoothWidget } from "./bluetooth";
import { clockWidget } from "./clock";
import { imageWidget } from "./image";
import { ledWidget } from "./led";
import { metricsWidget } from "./metrics";
import { microphoneWidget } from "./microphone";
import { playerWidget } from "./player";
import { systemWidget } from "./system";
import { terminalWidget } from "./terminal";
import { textWidget } from "./text";
import { visualizerWidget } from "./visualizer";
import { volumeWidget } from "./volume";

let registered = false;

export function registerLibrary(): void {
  if (registered) return;
  registered = true;
  for (const widget of [playerWidget, visualizerWidget, volumeWidget, ledWidget, metricsWidget, systemWidget, bluetoothWidget, terminalWidget, microphoneWidget, clockWidget, textWidget, imageWidget]) registerWidget(widget);
}
