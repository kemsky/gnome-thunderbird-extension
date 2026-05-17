import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const isThunderbirdApp = (app: Shell.App) => {
    const id = app.get_id();
    return id ? id.toLowerCase().includes('thunderbird') : false;
};

const isThunderbirdAppSource = (source: MessageTray.Source) => {
    const app: Shell.App = (source as any)['app'];

    if (app && isThunderbirdApp(app)) {
        return true;
    }

    // try match by title string
    const title = source.title ?? '';

    return title.toLowerCase().includes('thunderbird');
};

export default class ThunderbirdTrayExtension extends Extension {
    private _instance: ThunderbirdTrayInstance | undefined;

    enable() {
        this._instance = new ThunderbirdTrayInstance(this);
    }

    disable() {
        this._instance?.destroy();
        this._instance = undefined;
    }
}

const OPACITY_INACTIVE = 120;
const OPACITY_ACTIVE = 255;

const TAG = 'thunderbird-tray';

const APP_IDS = [
    'thunderbird_thunderbird.desktop',
    'thunderbird.desktop',
    'org.mozilla.Thunderbird.desktop',
    'mozilla-thunderbird.desktop'
];

type ThunderbirdTraySettings = {
    'hide-when-not-running': boolean;
};

class ThunderbirdTrayInstance {
    private readonly settings: Gio.Settings;

    private hidden = false;

    private thunderbirdApp?: Shell.App | undefined;

    private windowCreatedSubscription?: number | undefined;
    private readonly windowMinimizedSubscriptions = new Map<Meta.Window, number>();

    private notificationSourceSubscription?: number | undefined;
    private readonly notificationSourceSubscriptions = new Map<MessageTray.Source, number>();

    private readonly appSystem: Shell.AppSystem;

    private readonly windowTracker: Shell.WindowTracker;
    private readonly systemStray: PanelMenu.Button;
    private readonly systemStrayIcon: St.Icon;
    private readonly appStateSubscription: number;
    private readonly settingsSubscription: number;

    private readonly gioIcon: Gio.Icon;
    private readonly gioIconBadge: Gio.Icon;

    private hideIconWhenAppNotRunning: boolean = false;

    constructor(private extension: Extension) {
        this.settings = extension.getSettings();

        this.hideIconWhenAppNotRunning = this.get_boolean(this.settings, 'hide-when-not-running');

        this.appSystem = Shell.AppSystem.get_default();
        this.windowTracker = Shell.WindowTracker.get_default();

        // icons
        this.gioIcon = Gio.icon_new_for_string(`${this.extension.path}/assets/icon.svg`);
        this.gioIconBadge = Gio.icon_new_for_string(`${this.extension.path}/assets/icon-badge.svg`);

        // system tray
        this.systemStray = new PanelMenu.Button(0.0, 'Thunderbird Tray', true);
        this.systemStray.set_style('-natural-hpadding: 0; -minimum-hpadding: 0;');
        this.systemStrayIcon = new St.Icon({
            gicon: this.gioIcon,
            style_class: 'system-status-icon',
            opacity: OPACITY_INACTIVE
        });
        this.systemStray.add_child(this.systemStrayIcon);
        this.systemStray.visible = !this.hideIconWhenAppNotRunning;
        this.systemStray.connect('button-press-event', this.onClick.bind(this));
        Main.panel.addToStatusArea(this.extension.uuid, this.systemStray);

        this.patchAppSystem();

        this.startNotificationMonitoring();

        this.appStateSubscription = this.appSystem.connect('app-state-changed', this.onAppStateChanged.bind(this));

        this.settingsSubscription = this.settings.connect('changed', (source, key: keyof ThunderbirdTraySettings) => {
            switch (key) {
                case 'hide-when-not-running': {
                    this.hideIconWhenAppNotRunning = this.get_boolean(source, key);

                    this.systemStray.visible = this.hideIconWhenAppNotRunning ? this.thunderbirdApp != null : true;

                    break;
                }
                default:
                    break;
            }
        });

        this.checkThunderbirdRunning();
    }

    public destroy(): void {
        if (this.appStateSubscription) {
            this.appSystem.disconnect(this.appStateSubscription);
        }

        if (this.settingsSubscription) {
            this.settings.disconnect(this.settingsSubscription);
        }

        this.disconnectWindowCreated();

        if (this.hidden) {
            this.showApplication();
        }

        this.disconnectWindowSignals();

        this.unpatchAppSystem();

        this.stopNotificationMonitoring();

        this.systemStray.destroy();
    }

    private get_boolean(settings: Gio.Settings, key: keyof ThunderbirdTraySettings): boolean {
        return settings.get_boolean(key) ?? false;
    }

    private onClick(widget: St.Widget, event: Clutter.Event): void {
        this.updateTrayIcon(false);

        if (!this.thunderbirdApp || this.thunderbirdApp.get_state() !== Shell.AppState.RUNNING) {
            this.launchThunderbird();
            return;
        }

        const windows = this.getAppWindows(this.thunderbirdApp);

        if (!windows.length) {
            this.launchThunderbird();
            return;
        }

        this.showApplication();

        for (const window of windows) {
            window.unminimize();
        }

        windows[0].activate(global.get_current_time());
    }

    private updateTrayIcon(hasUnread: boolean): void {
        if (hasUnread) {
            this.systemStrayIcon.gicon = this.gioIconBadge;
        } else {
            this.systemStrayIcon.gicon = this.gioIcon;
        }
    }

    private startNotificationMonitoring(): void {
        this.notificationSourceSubscription = Main.messageTray.connect('source-added', this.onNotificationSourceAdded.bind(this));

        for (const source of Main.messageTray.getSources()) {
            this.watchNotificationSource(source);
        }
    }

    private stopNotificationMonitoring(): void {
        if (this.notificationSourceSubscription) {
            Main.messageTray.disconnect(this.notificationSourceSubscription);
            this.notificationSourceSubscription = undefined;
        }

        for (const [source, id] of this.notificationSourceSubscriptions) {
            try {
                source.disconnect(id);
            } catch (_e) {
                console.error(TAG, 'failed to disconnect', _e);
            }
        }

        this.notificationSourceSubscriptions.clear();
    }

    private onNotificationSourceAdded(_tray: MessageTray.MessageTray, source: MessageTray.Source): void {
        this.watchNotificationSource(source);
    }

    private watchNotificationSource(source: MessageTray.Source): void {
        if (this.notificationSourceSubscriptions.has(source)) {
            return;
        }

        if (!isThunderbirdAppSource(source)) {
            return;
        }

        const subscription = source.connect('notification-added', (_source, _notif) => {
            this.updateTrayIcon(true);
        });

        this.notificationSourceSubscriptions.set(source, subscription);
    }

    private onAppStateChanged(_appSystem: Shell.AppSystem, app: Shell.App): void {
        if (!isThunderbirdApp(app)) {
            return;
        }

        if (app.get_state() === Shell.AppState.RUNNING) {
            this.onThunderbirdStarted(app);
        } else if (app.get_state() === Shell.AppState.STOPPED) {
            this.onThunderbirdStopped();
        }
    }

    private checkThunderbirdRunning(): void {
        for (const app of this.appSystem.get_running()) {
            if (isThunderbirdApp(app)) {
                this.onThunderbirdStarted(app);
                return;
            }
        }
    }

    private onThunderbirdStarted(app: Shell.App): void {
        if (this.thunderbirdApp === app) {
            return;
        }

        this.thunderbirdApp = app;

        if (this.systemStrayIcon) {
            this.systemStrayIcon.opacity = OPACITY_ACTIVE;
            this.systemStray.visible = true;
        }

        for (const window of app.get_windows()) {
            this.watchWindowMinimized(window);
        }

        this.windowCreatedSubscription = global.display.connect('window-created', (_display, window) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const windowApp = this.windowTracker.get_window_app(window);

                if (windowApp && isThunderbirdApp(windowApp)) {
                    this.watchWindowMinimized(window);

                    if (this.hidden) {
                        this.showApplication();
                    }
                }

                return GLib.SOURCE_REMOVE;
            });
        });
    }

    private watchWindowMinimized(window: Meta.Window): void {
        if (this.windowMinimizedSubscriptions.has(window)) {
            return;
        }

        const subscription = window.connect('notify::minimized', () => {
            if (window.minimized) {
                this.onWindowMinimized();
            } else if (this.hidden) {
                this.showApplication();
            }
        });

        this.windowMinimizedSubscriptions.set(window, subscription);
    }

    private onThunderbirdStopped(): void {
        this.disconnectWindowCreated();
        this.disconnectWindowSignals();

        this.hidden = false;

        if (this.thunderbirdApp) {
            this.unpatchAppGetWindows(this.thunderbirdApp);
        }

        this.thunderbirdApp = undefined;

        if (this.systemStrayIcon) {
            this.systemStrayIcon.opacity = OPACITY_INACTIVE;
            this.systemStrayIcon.gicon = this.gioIcon;
            this.systemStray.visible = !this.hideIconWhenAppNotRunning;
        }
    }

    private disconnectWindowCreated(): void {
        if (this.windowCreatedSubscription) {
            global.display.disconnect(this.windowCreatedSubscription);
            this.windowCreatedSubscription = undefined;
        }
    }

    private disconnectWindowSignals(): void {
        for (const [window, id] of this.windowMinimizedSubscriptions) {
            try {
                window.disconnect(id);
            } catch (_e) {
                console.error(TAG, 'failed to disconnect', _e);
            }
        }

        this.windowMinimizedSubscriptions.clear();
    }

    private onWindowMinimized(): void {
        if (!this.thunderbirdApp || this.hidden) {
            return;
        }

        // Read the real window list (before any own-property patch)
        const windows = this.getAppWindows(this.thunderbirdApp);

        if (windows.length > 0 && windows.every((w) => w.minimized)) {
            this.hideApplication();
        }
    }

    private hideApplication(): void {
        if (this.hidden || !this.thunderbirdApp) {
            return;
        }

        this.hidden = true;

        // Patch app.get_windows() so Ubuntu Dock removes the running-indicator
        // dots even for apps that are pinned as favourites
        this.thunderbirdApp.get_windows = () => [];

        // Tell the dock system something changed:
        //   1. app-state-changed  → triggers _queueRedisplay in Ubuntu Dock
        //   2. windows-changed    → triggers per-app window-indicator refresh
        this.triggerDockUpdate();
    }

    private showApplication(): void {
        if (!this.hidden) {
            return;
        }

        this.hidden = false;

        if (this.thunderbirdApp) {
            this.unpatchAppGetWindows(this.thunderbirdApp);
        }

        this.triggerDockUpdate();
    }

    private getAppWindows(app: Shell.App): Meta.Window[] {
        const patched = Object.prototype.hasOwnProperty.call(app, 'get_windows');
        if (patched) {
            // @ts-expect-error just do it
            delete app.get_windows;
        }
        const list = app.get_windows();
        if (patched) {
            app.get_windows = () => [];
        }
        return list;
    }

    private unpatchAppGetWindows(app: Shell.App): void {
        if (Object.prototype.hasOwnProperty.call(app, 'get_windows')) {
            // @ts-expect-error just do it
            delete app.get_windows;
        }
    }

    private triggerDockUpdate(): void {
        if (!this.thunderbirdApp) {
            return;
        }
        try {
            this.appSystem.emit('app-state-changed', this.thunderbirdApp);
        } catch (_e) {
            console.error(TAG, 'failed emit app-state-changed', _e);
        }
        try {
            this.thunderbirdApp.emit('windows-changed');
        } catch (_e) {
            console.error(TAG, 'failed emit windows-changed', _e);
        }
    }

    private launchThunderbird(): void {
        for (const id of APP_IDS) {
            const app = this.appSystem.lookup_app(id);
            if (app) {
                try {
                    if (app.launch(0, -1, Shell.AppLaunchGpu.APP_PREF)) {
                        return;
                    }
                    console.warn(TAG, 'failed to launch', id);
                } catch (_e) {
                    console.warn(TAG, 'failed to launch', id, _e);
                }
            }
        }
        try {
            if (GLib.spawn_command_line_async('thunderbird')) {
                return;
            }
            console.warn(TAG, 'failed to launch via shell');
        } catch (_e) {
            console.warn(TAG, 'failed to launch via shell', _e);
        }

        Main.notifyError('Thunderbird Tray', 'Unable to launch Thunderbird');
    }

    private patchAppSystem(): void {
        const get_running = this.appSystem.get_running.bind(this.appSystem);

        // that's how it is removed from the Dock:
        this.appSystem.get_running = () => {
            const apps = get_running();
            if (this.hidden && this.thunderbirdApp) {
                return apps.filter((a) => a !== this.thunderbirdApp);
            }
            return apps;
        };
    }

    private unpatchAppSystem(): void {
        // restore original method
        // @ts-expect-error just do it
        delete this.appSystem.get_running;
    }
}
