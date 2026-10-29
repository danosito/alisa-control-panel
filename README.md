# Alisa Control Panel

Веб-панель управления рутованной **Яндекс Станцией Лайт 2** (Plum), работающей без
Алисы: домашний экран из виджетов, который открывается с телефона или компьютера.

Сервер — один статический бинарник на Zig (armhf, штатная glibc колонки), фронтенд —
один HTML-файл, вшитый в бинарник. Никаких зависимостей на станции, кроме штатных
утилит (`bluetoothctl`/`dbus-send`, `arecord`, `amixer`).

## Возможности

- **Экраны из виджетов**: свободная сетка, перетаскивание и ресайз с допустимыми
  пропорциями для каждого виджета, несколько экранов со свайпом, режим редактирования
  долгим нажатием, раскладки сохраняются в браузере.
- **Плеер**: что играет по Bluetooth (AVRCP) — трек, исполнитель, обложка (iTunes Search),
  устройство-источник, таймлайн, управление.
- **Визуализация** в реальном времени: столбики, зеркало, LED-блоки, осциллограф, круг,
  водопад; источник — то, что играет колонка, или микрофон.
- **Подсветка**: цвет, яркость и режимы, которые работают на самой станции, даже с
  закрытой страницей — дыхание, радуга, свеча и светомузыка (пульс, спектр, бит, поток).
- **Микрофон**: уровни и спектр с PDM-микрофонов напрямую, без стека Яндекса.
- **Bluetooth**: сопряжение, подключение, отключение, «забыть».
- **Терминал**: настоящий PTY (xterm.js) в виджете, можно задать стартовую команду (`btop`).
- **Мониторинг**: CPU, RAM, температура, сеть с историей; Wi-Fi, флеш, аптайм, нагрузка.
- **Громкость**, часы, текст, картинка.
- **Вход** по паролю или passkey; **HTTP** или **HTTPS**.

Свой виджет — один файл: [docs/widgets.md](docs/widgets.md).

## Что нужно

- Станция Лайт 2 с root по SSH (см. [hackalice.me](https://hackalice.me)) и Entware.
  Терминалу нужен `/opt/bin/bash` (`opkg install bash`) или выберите в настройках виджета `sh`.
- Алиса (quasar) остановлена: панель сама работает с микрофонами, подсветкой и Bluetooth.
- На компьютере для сборки: [Zig 0.15.2](https://ziglang.org/download/) и Node.js 20+.

## Быстрый старт (HTTP + пароль, в домашней сети)

```sh
cp deploy.env.example deploy.env      # HOST=root@<IP станции>, при необходимости SSH_KEY
(cd web && npm ci)
scripts/deploy.sh                     # сборка, установка, запуск
```

Первый деплой кладёт на станцию `/data/opt/etc/alisa-panel/panel.env` из
[deploy/panel.env.example](deploy/panel.env.example). Впишите туда пароль и перезапустите:

```sh
ssh root@<IP> 'vi /data/opt/etc/alisa-panel/panel.env && /etc/init.d/S98alisa-panel restart'
```

Панель — на `http://<IP станции>:8080`. Лог — `/data/opt/etc/alisa-panel/alisa-panel.log`.

## HTTPS и passkey

Passkey (WebAuthn) браузеры разрешают только по HTTPS на доменном имени. Нужен домен,
указывающий на станцию (хоть в локальном DNS), и сертификат для него — например,
Let's Encrypt через DNS-01. Файлы положите в `/data/opt/etc/alisa-panel/tls/`:

```sh
PANEL_TLS=on
PANEL_PORT=443
PANEL_AUTH=passkey
PANEL_ORIGIN=https://panel.example.com
```

Первый вход создаёт passkey владельца; дальше вход только им. Пароль по HTTPS тоже
работает (`PANEL_AUTH=password`). Вместо встроенного TLS можно поставить панель за
обратный прокси: `PANEL_TLS=off`, прокси терминирует HTTPS.

## Настройки (`panel.env`)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PANEL_NAME` | `Станция` | имя в интерфейсе и в запросе passkey |
| `PANEL_AUTH` | `passkey` с TLS, иначе `password` | способ входа |
| `PANEL_PASSWORD` | — | пароль (≥ 8 символов) для `password` |
| `PANEL_TLS` | `auto` | `on`/`off`/`auto` (включён, если есть сертификат и ключ) |
| `PANEL_PORT` | `443` с TLS, `8080` без | порт |
| `PANEL_BIND` | `0.0.0.0` | адрес |
| `PANEL_TLS_CERT`, `PANEL_TLS_KEY` | `<data>/tls/fullchain.pem`, `privkey.pem` | сертификат |
| `PANEL_ORIGIN`, `PANEL_RP_ID` | — | адрес панели и домен для passkey |

Ошибка в настройках не даёт серверу стартовать, причина пишется в лог.

## Что где на станции

| Путь | Что |
|---|---|
| `/data/opt/bin/alisa-panel` | сервер |
| `/data/opt/bin/alisa-panel-supervise` | перезапуск при падении, сохранение core dump |
| `/data/opt/bin/alisa-panel-btguard` | сторож Bluetooth-звука ([docs/bluetooth-audio.md](docs/bluetooth-audio.md)) |
| `/etc/init.d/S98alisa-panel` | автозапуск |
| `/data/opt/etc/alisa-panel/` | `panel.env`, вход (`auth.json`, `session`), подсветка, `tls/`, лог |
| `/data/opt/share/alisa-panel/assets/` | файлы для `/assets/*`, например `logo.png` для виджета «Картинка» |

Имя установки задаётся `APP` в `deploy.env`: так на одной станции можно держать свою
раскладку путей.

## Разработка

```sh
cd web
npm run watch        # пересборка src/index.html при изменениях
npm run preview      # локальный сервер с mock API (PANEL_BACKEND=http://<IP>:8080 — прокси на станцию)
npm run kit          # web/dist/kit.html: все виджеты во всех размерах на фейковых данных
npm run check        # проверка типов
cd .. && zig build test                 # тесты разбора BlueZ, анализатора, цветов
scripts/coredump.sh --bt                # бэктрейс последнего падения со станции
```

Сборка сервера вручную: `npm --prefix web run build && zig build -Dtarget=arm-linux-gnueabihf.2.30 -Doptimize=ReleaseSafe`
(фронтенд вшивается в бинарник, поэтому сначала он).

## Безопасность

- Виджет «Терминал» — это root-shell на станции. Не открывайте панель в интернет без
  входа; для доступа извне используйте passkey и HTTPS или VPN.
- Пароль сравнивается по SHA-256 в постоянное время; после 5 неудач вход блокируется на 30 с.
- Сессия хранится в `sessionStorage` вкладки и в `session` на станции (переживает
  перезапуск сервера). Выход — в меню профиля.

## Сторонний код

[passcay](https://github.com/uzyn/passcay) (WebAuthn, MIT, лежит в `vendor/passcay`),
[tls.zig](https://github.com/ianic/tls.zig), [xterm.js](https://xtermjs.org),
[GridStack](https://gridstackjs.com), [uPlot](https://github.com/leeoniya/uPlot),
[iro.js](https://iro.js.org).
