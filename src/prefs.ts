import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GnomeRectanglePreferences extends ExtensionPreferences {
    _settings?: Gio.Settings;

    fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        this._settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'dialog-information-symbolic'
        });

        const hideGroup = new Adw.PreferencesGroup({
            title: _('Hide icon'),
            description: _('Hide tray icon when Thunderbird is not running')
        });
        page.add(hideGroup);

        const hideEnabled = new Adw.SwitchRow({
            title: _('Enabled'),
            subtitle: _('Whether to hide icon')
        });
        hideGroup.add(hideEnabled);

        window.add(page);

        this._settings!.bind('hide-when-not-running', hideEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);

        return Promise.resolve();
    }
}
