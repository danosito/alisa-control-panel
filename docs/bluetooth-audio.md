# Bluetooth-звук на Станции Лайт 2 без Алисы

Как устроена цепочка A2DP на рутованной Yandex Station Lite 2 (Plum, BlueZ 5.70,
bluez-alsa 4.1.1, усилитель FS2105), какие три ловушки ломают звук и что с ними делает
`deploy/panel-btguard`.

## Цепочка

```text
телефон / ПК (A2DP source, SBC 44.1 кГц)
        │
        ▼
bluetoothd ── just-works-bluez-agent (S54: сопряжение без PIN, Trusted=yes)
        │
        ▼
bluealsa -p a2dp-sink                         (S52)
        │  PCM bluealsa:DEV=…,PROFILE=a2dp
        ▼
bluealsa-aplay -D bluetooth                   (S53, /etc/bluealsa-aplay.conf)
        ▼
softvol "Bluetooth Master" → softvol "Master" → dmix 48 кГц → hw:0,0 (TDM-B) → FS2105
                                                            ▲
                                       битовые часы TDM-B берутся от mpll1
```

Громкость: `Bluetooth Master` (`/etc/asound.conf`) — уровень Bluetooth-потока,
`Master` (`/etc/asound-softvol.conf`) — общая громкость колонки (её меняет виджет «Громкость»).

## Три ловушки

### 1. Колонка выглядит как телефон → соединение рвётся через несколько секунд

Штатный `S52bluealsa` запускает `bluealsa -p a2dp-sink -p a2dp-source -p hfp-ag`.
С ролями source и HFP Audio Gateway колонка рекламирует себя как телефон: Windows
пытается подключить лишние профили, в логе `bluetoothd`:

```text
a2dp_select_capabilities() Unable to select SEP
a2dp-source profile connect failed …: Device or resource busy
```

и через ~4 с соединение закрывается (`Remote User Terminated Connection`).

**Решение:** в `/etc/init.d/S52bluealsa` оставить только `-p a2dp-sink --sbc-quality=high`.
Класс устройства станет `0x040414` (Audio/Video, Loudspeaker). На Windows после этого
стоит удалить и заново добавить колонку: старые узлы «Hands-Free» остаются в диспетчере устройств.

### 2. Поток идёт, а колонка молчит

Если `bluealsa-aplay` пишет напрямую в `hw:0,0` с частотой источника 44.1 кГц, усилитель
остаётся без правильной синхронизации: `/proc/asound/card0/pcm0p/sub0/status` показывает
`RUNNING`, пакеты A2DP приходят, звука нет.

**Решение:** запускать только штатным `S53bluealsa-aplay` (`-D bluetooth`): поток идёт через
softvol и dmix, который всегда работает на 48 кГц.

### 3. Звук замедлен, задержка растёт

Частоту TDM-B задаёт `mpll1`, и перенастраивает его только путь **захвата**. После одного
открытия `hw:0,0` на 44.1 кГц `mpll1` остаётся в семействе 44.1 кГц (22579196 Гц в
`/sys/kernel/debug/clk/clk_summary`), и любой последующий поток 48 кГц реально играет
на ~44.1 кГц: всё медленнее на 8 % и задержка постоянно растёт.

Проверка реальной частоты (должно быть ~48000):

```sh
S=/proc/asound/card0/pcm0p/sub0/status
a=$(grep hw_ptr $S | tr -dc 0-9); t0=$(cut -d' ' -f1 /proc/uptime); sleep 5
b=$(grep hw_ptr $S | tr -dc 0-9); t1=$(cut -d' ' -f1 /proc/uptime)
awk -v a=$a -v b=$b -v t0=$t0 -v t1=$t1 'BEGIN{printf "%.0f Hz\n", (b-a)/(t1-t0)}'
```

**Решение:** короткий захват на 48 кГц перенастраивает часы:
`arecord -q -D hw:0,0 -f S16_LE -r 48000 -c 2 -d 1 -t raw /dev/null` (было 44230 → стало 47987 Гц).

## Сторож `panel-btguard`

Запускается из `S98<APP>` и раз в 10 с:

- запускает `bluetoothd`, `bluealsa`, агент сопряжения и `bluealsa-aplay` штатными
  init-скриптами, если они упали;
- перезапускает `bluealsa` с ролью только sink, если его запустили с другими ролями;
- перерегистрирует агент после перезапуска `bluetoothd` (регистрация живёт в процессе демона);
- перезапускает `bluealsa-aplay`, если он не на PCM `bluetooth` или запущен дважды;
- лечит `mpll1` из семейства 44.1 кГц захватом на 48 кГц: сразу, если ничего не играет,
  и после двух подряд наблюдений во время воспроизведения.

Все действия пишутся в лог панели с префиксом `btguard:`.

## Диагностика

```sh
btmon -C 400 -T -w /tmp/bt.snoop & sleep 15; kill %1
btmon -C 400 -T -r /tmp/bt.snoop | grep -E "^= bluetoothd|AVDTP: [A-Z]|Reason:"
bluealsa-aplay -L                       # какие устройства сейчас отдают звук
bluetoothctl info <MAC>                 # Paired/Trusted/Connected
grep -E "mpll1" /sys/kernel/debug/clk/clk_summary
```

## macOS не передаёт название трека

С Windows и Android плеер панели показывает трек через AVRCP; с Mac — только
«играет/пауза» и управление. Это ограничение macOS, а не колонки:

- Mac отвечает на `RegisterNotification(TRACK_CHANGED)` идентификатором
  `0xFFFFFFFFFFFFFFFF` («трек не выбран») и не отвечает на `GetElementAttributes` —
  ни на запрос всех атрибутов, ни на явный список (Title, Artist, …), как у автомагнитол.
  Собственный лог macOS (`log show --predicate 'process == "bluetoothd"'`) подтверждает,
  что запрос получен: `Received 'get element attributes' … request`.
- Модуль now-playing в `bluetoothd` macOS 15 берёт из MediaRemote только состояние
  воспроизведения и умеет отправлять команды; название трека он не запрашивает.
  Настройки (`defaults`), включающей метаданные, нет.

Работающие обходы — AirPlay 2 (shairport-sync, метаданные и обложка от любого
приложения, но задержка ~2 с) или агент на Mac, который читает Now Playing
(`media-control`) и отправляет его панели.
