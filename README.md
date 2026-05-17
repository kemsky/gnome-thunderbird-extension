# Gnome shell extension for Thunderbird

A GNOME Shell extension that adds a Thunderbird system tray icon to the top panel.

## Features

- **Tray icon** — always visible in the top panel; greyed out when Thunderbird is not running
- **Dock hiding** — automatically removes Thunderbird from the dock when all its windows are minimized
- **One-click restore** — click the tray icon to unminimize all windows and bring Thunderbird back to the dock
- **Unread badge** — a small orange dot appears on the tray icon when Thunderbird sends a desktop notification
- **Launch** — clicking the tray icon when Thunderbird is not running launches it
- **Wayland native** — no X11 tools required

## How it works

Extension patches `Shell.AppSystem.running_apps` and `Shell.App.get_windows` to hide app from Dock and overlay.
Also, it monitors notifications to detect when Thunderbird receives new email.

## Requirements

- GNOME Shell 45–50
- Thunderbird (package, snap, or Flatpak)
- NodeJS

## Build

```bash
yarn install
yarn package
```

## Installation

```bash
yarn extension-install
yarn extension-enable
```
or
```bash
yarn extension-install
gnome-extensions enable thunderbird-tray@kemsky.by
```

Log out and back in for the extension to fully load.

> **Note:** GNOME Shell caches JavaScript modules in memory. Code changes only take full effect after a session logout/login.

Optionally you can install `gnome-extensions-app` to manage extension preferences (https://apps.gnome.org/Extensions/):

```bash
sudo apt-get install gnome-extensions-app
```

## Uninstall

```bash
yarn extension-uninstall
```
or
```bash
gnome-extensions uninstall thunderbird-tray@kemsky.by
```

## License

MIT