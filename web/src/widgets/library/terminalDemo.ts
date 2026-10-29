// Static screens for the terminal widget in previews and the demo (no PTY
// there). Sized to the terminal so nothing wraps.

const C = { dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m", bold: "\x1b[1m", grey: "\x1b[90m" };
const prompt = `${C.bold}\x1b[32mroot${C.reset}@${C.bold}${C.cyan}station${C.reset}:${C.bold}\x1b[34m~${C.reset} # `;

/** Plain shell session. */
export function demoShell(): string {
  return [
    `${prompt}uptime`,
    " 21:42:07 up 3 days, load 1.42",
    `${prompt}bluetoothctl devices`,
    "Device 00:11:22:33:44:01 Desktop PC",
    "Device 00:11:22:33:44:02 Android Phone",
    prompt,
  ].join("\r\n");
}

const spark = "▁▂▃▄▅▆▇█";
function sparkline(n: number, seed: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += spark[Math.floor((Math.sin(i * 0.7 + seed) * 0.5 + 0.5) * 0.6 * 8 + (Math.sin(i * 2.3 + seed * 3) * 0.5 + 0.5) * 0.4 * 8) % 8];
  return out;
}
function bar(value: number, width: number): string {
  const filled = Math.round((value / 100) * width);
  const color = value > 70 ? C.red : value > 40 ? C.yellow : C.green;
  return `${color}${"■".repeat(filled)}${C.grey}${"■".repeat(Math.max(0, width - filled))}${C.reset}`;
}
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
function line(content: string, width: number, color = C.grey): string {
  return `${color}│${C.reset}${content}${" ".repeat(Math.max(0, width - 2 - visible(content)))}${color}│${C.reset}`;
}
function top(title: string, width: number, color: string, right = ""): string {
  const used = 4 + title.length + (right ? right.length + 2 : 0);
  return `${color}┌─${C.bold}${title}${C.reset}${color}${"─".repeat(Math.max(1, width - used))}${right ? `┤${C.reset}${right}${color}├` : ""}─┐${C.reset}`;
}
const bottom = (width: number, color: string) => `${color}└${"─".repeat(width - 2)}┘${C.reset}`;

/** A btop-like dashboard with plausible station numbers. */
export function demoBtop(cols: number, rows: number): string {
  const w = Math.max(40, Math.min(cols, 140));
  const out: string[] = [];
  const cpuColor = "\x1b[38;5;108m", memColor = "\x1b[38;5;179m", procColor = "\x1b[38;5;132m";
  out.push(top("cpu", w, cpuColor, "21:42:07"));
  out.push(line(` ${C.bold}CPU${C.reset} ${bar(34, Math.max(8, Math.floor(w / 4)))} 34%  ${C.green}${sparkline(Math.max(4, w - Math.floor(w / 4) - 18), 1)}${C.reset}`, w, cpuColor));
  const cores = [28, 41, 22, 36];
  const cw = Math.max(4, Math.floor(w / 10));
  out.push(line(cores.map((v, i) => ` C${i} ${bar(v, cw)} ${String(v).padStart(2)}%`).join(" "), w, cpuColor));
  out.push(line(` ${C.dim}load${C.reset} 1.42 1.55 1.61   ${C.dim}temp${C.reset} 48°C   ${C.dim}up${C.reset} 3d 02:11`, w, cpuColor));
  out.push(bottom(w, cpuColor));
  out.push(top("mem", w, memColor));
  out.push(line(` Used  ${bar(41, Math.max(8, Math.floor(w / 3)))}  96 MiB / 237 MiB`, w, memColor));
  out.push(line(` Avail ${bar(59, Math.max(8, Math.floor(w / 3)))} 141 MiB   ${C.cyan}▼ 540 Kbps  ▲ 46 Kbps${C.reset}`, w, memColor));
  out.push(bottom(w, memColor));
  const procs: Array<[number, string, number, string]> = [
    [1308, "alisa-panel", 7.6, "4.0M"], [1433, "bluealsa-aplay", 5.2, "1.1M"], [1351, "bluealsa", 2.6, "2.9M"],
    [1352, "bluetoothd", 1.3, "3.0M"], [1252, "dbus-daemon", 0.4, "11M"], [654, "irq/37-meson", 2.5, "0B"],
    [1310, "hi_irq", 5.1, "0B"], [2081, "btop", 3.9, "2.4M"], [1199, "dropbear", 0.1, "1.2M"], [998, "chronyd", 0.0, "1.0M"],
    [1281, "wpa_supplicant", 0.3, "2.1M"], [1290, "dhcpcd", 0.0, "0.9M"], [7, "rcu_preempt", 0.2, "0B"], [10, "ksoftirqd/0", 0.4, "0B"],
    [1355, "just-works-agent", 0.0, "0.6M"], [421, "kworker/0:2", 0.1, "0B"], [1191, "syslogd", 0.0, "0.4M"], [1, "init", 0.0, "0.8M"],
    [1271, "unbound", 0.1, "3.4M"], [2077, "bash", 0.0, "1.6M"], [1240, "klogd", 0.0, "0.3M"], [12, "migration/1", 0.0, "0B"],
  ];
  out.push(top("proc", w, procColor));
  out.push(line(` ${C.bold}${"Pid".padStart(5)} ${"Program".padEnd(16)} ${"Cpu%".padStart(5)} ${"Mem".padStart(6)}${C.reset}`, w, procColor));
  const room = Math.max(1, rows - out.length - 2);
  for (const [pid, name, cpu, mem] of procs.slice(0, room)) out.push(line(` ${String(pid).padStart(5)} ${C.cyan}${name.padEnd(16)}${C.reset} ${cpu.toFixed(1).padStart(5)} ${mem.padStart(6)}`, w, procColor));
  out.push(bottom(w, procColor));
  return out.slice(0, rows).join("\r\n");
}
