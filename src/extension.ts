import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
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
    // Fallback: match by title string for older GNOME versions
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

const OPACITY_INACTIVE = 128;
const OPACITY_ACTIVE = 255;

const TAG = 'thunderbird-tray';

const APP_IDS = [
    'thunderbird_thunderbird.desktop',
    'thunderbird.desktop',
    'org.mozilla.Thunderbird.desktop',
    'mozilla-thunderbird.desktop'
];

class ThunderbirdTrayInstance {
    private readonly settings: Gio.Settings;

    private settingsAnimate: boolean;

    private hiddenFromDock = false;

    private thunderbirdApp?: Shell.App | undefined;

    private windowCreatedSubscription?: number | undefined;
    private notificationSourceSubscription?: number | undefined;
    private windowSubscription = new Map<Meta.Window, number>();
    private messageTraySourceSubscriptions = new Map<MessageTray.Source, number>();
    private hasUnread: boolean = false;

    private readonly appSystem: Shell.AppSystem;

    private readonly windowTracker: Shell.WindowTracker;
    private readonly systemStray: PanelMenu.Button;
    private readonly systemStrayIcon: St.Icon;
    private readonly appStateSubscription: number;

    private readonly gioIcon: Gio.Icon;
    private readonly gioIconBadge: Gio.Icon;

    constructor(private extension: Extension) {
        this.settings = extension.getSettings();
        this.settingsAnimate = this.settings.get_boolean('animate') ?? true;

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
        this.systemStray.connect('button-press-event', this.onClick.bind(this));
        Main.panel.addToStatusArea(this.extension.uuid, this.systemStray);

        this.patchAppSystem();

        this.setupNotificationMonitor();

        this.appStateSubscription = this.appSystem.connect('app-state-changed', this.onAppStateChanged.bind(this));

        this.checkRunningThunderbird();
    }

    public destroy(): void {
        if (this.appStateSubscription) {
            this.appSystem.disconnect(this.appStateSubscription);
        }

        this.disconnectWindowCreated();

        // Restore dock state before unloading so nothing stays hidden
        if (this.hiddenFromDock) {
            this.showInDock();
        }

        this.disconnectWindowSignals();
        this.unpatchAppSystem();
        this.teardownNotificationMonitor();

        this.systemStray.destroy();
    }

    private onClick(): void {
        this.setUnreadState(false);

        if (!this.thunderbirdApp || this.thunderbirdApp.get_state() !== Shell.AppState.RUNNING) {
            this.launchThunderbird();
            return;
        }

        const windows = this.realGetWindows(this.thunderbirdApp);

        if (!windows.length) {
            this.launchThunderbird();
            return;
        }

        this.showInDock();

        for (const window of windows) {
            window.unminimize();
        }

        windows[0].activate(global.get_current_time());
    }

    private setUnreadState(hasUnread: boolean): void {
        this.hasUnread = hasUnread;

        if (hasUnread) {
            this.systemStrayIcon.gicon = this.gioIconBadge;
        } else {
            this.systemStrayIcon.gicon = this.gioIcon;
        }
    }

    private setupNotificationMonitor(): void {
        this.notificationSourceSubscription = Main.messageTray.connect('source-added', this.onNotificationSourceAdded.bind(this));

        for (const source of Main.messageTray.getSources()) {
            this.watchNotificationSource(source);
        }
    }

    private teardownNotificationMonitor(): void {
        if (this.notificationSourceSubscription) {
            Main.messageTray.disconnect(this.notificationSourceSubscription);
            this.notificationSourceSubscription = undefined;
        }

        for (const [source, id] of this.messageTraySourceSubscriptions) {
            try {
                source.disconnect(id);
            } catch (_e) {
                console.error(TAG, 'failed to disconnect', _e);
            }
        }

        this.messageTraySourceSubscriptions.clear();
    }

    private onNotificationSourceAdded(_tray: MessageTray.MessageTray, source: MessageTray.Source): void {
        this.watchNotificationSource(source);
    }

    private watchNotificationSource(source: MessageTray.Source): void {
        if (this.messageTraySourceSubscriptions.has(source)) {
            return;
        }

        if (!isThunderbirdAppSource(source)) {
            return;
        }

        const subscription = source.connect('notification-added', (_source, _notif) => {
            this.setUnreadState(true);
        });

        this.messageTraySourceSubscriptions.set(source, subscription);
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

    private checkRunningThunderbird(): void {
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
        }

        for (const window of app.get_windows()) {
            this.watchWindow(window);
        }

        this.windowCreatedSubscription = global.display.connect('window-created', (_display, window) => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                const wa = this.windowTracker.get_window_app(window);
                if (wa && isThunderbirdApp(wa)) {
                    this.watchWindow(window);

                    // A new window appearing means Thunderbird is active
                    if (this.hiddenFromDock) {
                        this.showInDock();
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    private onThunderbirdStopped(): void {
        this.disconnectWindowCreated();
        this.disconnectWindowSignals();

        this.hiddenFromDock = false;

        if (this.thunderbirdApp) {
            this.restoreAppGetWindows(this.thunderbirdApp);
        }

        this.thunderbirdApp = undefined;

        if (this.systemStrayIcon) {
            this.systemStrayIcon.opacity = OPACITY_INACTIVE;
            this.systemStrayIcon.gicon = this.gioIcon;
        }
    }

    private disconnectWindowCreated(): void {
        if (this.windowCreatedSubscription) {
            global.display.disconnect(this.windowCreatedSubscription);
            this.windowCreatedSubscription = undefined;
        }
    }

    private watchWindow(window: Meta.Window): void {
        if (this.windowSubscription.has(window)) {
            return;
        }

        const subscription = window.connect('notify::minimized', () => {
            if (window.minimized) {
                this.onWindowMinimized();
            } else if (this.hiddenFromDock) {
                this.showInDock();
            }
        });

        this.windowSubscription.set(window, subscription);
    }

    private disconnectWindowSignals(): void {
        for (const [window, id] of this.windowSubscription) {
            try {
                window.disconnect(id);
            } catch (_e) {
                console.error(TAG, 'failed to disconnect', _e);
            }
        }

        this.windowSubscription.clear();
    }

    private onWindowMinimized(): void {
        if (!this.thunderbirdApp || this.hiddenFromDock) {
            return;
        }

        // Read the real window list (before any own-property patch)
        const windows = this.realGetWindows(this.thunderbirdApp);

        if (windows.length > 0 && windows.every((w) => w.minimized)) {
            this.hideFromDock();
        }
    }

    private hideFromDock(): void {
        if (this.hiddenFromDock || !this.thunderbirdApp) {
            return;
        }

        this.hiddenFromDock = true;

        // Patch app.get_windows() so Ubuntu Dock removes the running-indicator
        // dots even for apps that are pinned as favourites
        this.thunderbirdApp.get_windows = () => [];

        // Tell the dock system something changed:
        //   1. app-state-changed  → triggers _queueRedisplay in Ubuntu Dock
        //   2. windows-changed    → triggers per-app window-indicator refresh
        this.emitDockRefresh();
    }

    private showInDock(): void {
        if (!this.hiddenFromDock) {
            return;
        }

        this.hiddenFromDock = false;

        if (this.thunderbirdApp) {
            this.restoreAppGetWindows(this.thunderbirdApp);
        }

        this.emitDockRefresh();
    }

    // Returns the real window list regardless of any own-property override
    private realGetWindows(app: Shell.App): Meta.Window[] {
        const patched = Object.prototype.hasOwnProperty.call(app, 'get_windows');
        if (patched) {
            // @ts-expect-error none of your business
            delete app.get_windows;
        }
        const list = app.get_windows();
        if (patched) {
            app.get_windows = () => [];
        }
        return list;
    }

    private restoreAppGetWindows(app: Shell.App): void {
        if (Object.prototype.hasOwnProperty.call(app, 'get_windows')) {
            // @ts-expect-error none of your business
            delete app.get_windows;
        }
    }

    private emitDockRefresh(): void {
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
        const original = this.appSystem.get_running.bind(this.appSystem);

        // that's how it is removed from the Dock:
        this.appSystem.get_running = () => {
            const apps = original();
            if (this.hiddenFromDock && this.thunderbirdApp) {
                return apps.filter((a) => a !== this.thunderbirdApp);
            }
            return apps;
        };
    }

    private unpatchAppSystem(): void {
        // restore original method
        // @ts-expect-error none of your business
        delete this.appSystem.get_running;
    }
}
