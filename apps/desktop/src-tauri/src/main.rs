//! Session Inbox shell: menu-bar bridge for the daemon. It renders nothing itself;
//! its windows load the daemon-served UI, and it only relays notifications,
//! the badge, deep links and the global shortcut, and reports what it may do.
mod channel;
mod daemon;
mod notify;
mod shortcut;

use daemon::{Connection, Msg};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    ActivationPolicy, AppHandle, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Window label and the query its page is opened with (the token is added per load, D-095).
const WINDOWS: [(&str, &str); 2] = [("main", ""), ("popover", "view=compact")];

/// Where the "Notifications are off" line goes in the tray menu (after Pause).
const NOTIF_LINE_POS: usize = 2;
const NOTIFICATION_SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

struct Shell {
    paused: AtomicBool,
    status: MenuItem<Wry>,
    last_blur: Mutex<Option<Instant>>,
    menu: Menu<Wry>,
    notif_off: MenuItem<Wry>,
    /// The tray's "Open inbox" item, whose accelerator follows the binding.
    open_item: MenuItem<Wry>,
    /// The accelerator currently registered globally, if any.
    open_shortcut: Mutex<Option<String>>,
    notif_off_shown: AtomicBool,
    version: String,
}

/// Called by `notify::refresh` with the current system settings; `report` is
/// set on startup, reconnect and change. Never retries: the next one resends.
pub fn notifications_changed(app: &AppHandle, s: notify::Settings, report: bool) {
    let Some(shell) = app.try_state::<Shell>() else { return };
    let denied = s.notifications == "denied";
    if shell.notif_off_shown.swap(denied, Ordering::Relaxed) != denied {
        let r = if denied { shell.menu.insert(&shell.notif_off, NOTIF_LINE_POS) } else { shell.menu.remove(&shell.notif_off) };
        if let Err(e) = r {
            eprintln!("tray menu update failed: {e}");
        }
    }
    if !report {
        return;
    }
    let body = daemon::status_body(s.notifications, s.alert_style, &shell.version, channel::current().name);
    std::thread::spawn(move || {
        let Some(c) = daemon::current() else { return };
        match daemon::report_status(&c, &body) {
            Ok(code) => eprintln!("shell status {body} -> {code}"),
            Err(e) => eprintln!("shell status report failed: {e}"),
        }
    });
}

fn open_notification_settings() {
    let ok = std::process::Command::new("open").arg(NOTIFICATION_SETTINGS_URL).status().is_ok_and(|s| s.success());
    if !ok {
        let _ = std::process::Command::new("open").args(["-b", "com.apple.systempreferences"]).status();
    }
}

/// `<scheme>://item/<id>` -> `#/item/<id>`, same for `session`.
fn deep_link_hash(url: &str) -> Option<String> {
    deep_link_hash_for(url, channel::current().scheme)
}

fn deep_link_hash_for(url: &str, scheme: &str) -> Option<String> {
    let u = tauri::Url::parse(url).ok()?;
    let kind = u.host_str().filter(|k| matches!(*k, "item" | "session"))?;
    let id = u.path().trim_matches('/');
    (u.scheme() == scheme && !id.is_empty()).then(|| format!("#/{kind}/{id}"))
}

fn on_daemon_origin(w: &WebviewWindow, c: &Connection) -> bool {
    w.url().is_ok_and(|u| u.host_str() == Some("127.0.0.1") && u.port() == Some(c.http_port))
}

/// Point both windows at the daemon's UI (also after the daemon restarts on a new port).
fn sync_windows(app: &AppHandle, c: &Connection) {
    for (label, query) in WINDOWS {
        if let Some(w) = app.get_webview_window(label) {
            if !on_daemon_origin(&w, c) {
                let _ = w.navigate(c.page_url(query, "").parse().unwrap());
            }
        }
    }
}

/// Show the main window, optionally at a route such as `#/item/<id>`.
pub fn show_main(app: &AppHandle, hash: Option<String>) {
    let Some(w) = app.get_webview_window("main") else { return };
    if let (Some(h), Some(c)) = (hash, daemon::current()) {
        if on_daemon_origin(&w, &c) {
            let _ = w.eval(format!("location.hash = {}", serde_json::to_string(&h).unwrap()));
        } else {
            let _ = w.navigate(c.page_url("", &h).parse().unwrap());
        }
    }
    if let Some(p) = app.get_webview_window("popover") {
        let _ = p.hide();
    }
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

fn toggle_popover(app: &AppHandle, anchor: Option<(PhysicalPosition<f64>, f64)>) {
    let Some(p) = app.get_webview_window("popover") else { return };
    if p.is_visible().unwrap_or(false) {
        let _ = p.hide();
        return;
    }
    // Clicking the tray blurs (and so hides) the popover just before the click lands.
    let blurred = app.state::<Shell>().last_blur.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if blurred {
        return;
    }
    if let (Some((pos, width)), Ok(size)) = (anchor, p.outer_size()) {
        let x = pos.x + width / 2.0 - size.width as f64 / 2.0;
        let _ = p.set_position(PhysicalPosition::new(x as i32, pos.y as i32));
    }
    let _ = p.show();
    let _ = p.set_focus();
}

fn set_badge(app: &AppHandle, count: u32) {
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_title((count > 0).then(|| count.to_string()));
    }
}

/// A login item written by a copy of the app that lived somewhere else (a build folder, an
/// older path) would launch that stale copy at login. True when the LaunchAgent plist doesn't
/// name this executable (S-022).
fn login_item_is_stale(plist: &str, exe: &str) -> bool {
    !plist.contains(exe)
}

/// Ask launchd to start the daemon agent if it isn't running. Never spawns it as a child,
/// and never kills one that is already up: without `-k` a running job is left alone, so an
/// installer or updater that has just restarted the daemon isn't restarted again (S-020).
fn kickstart() {
    let uid = std::process::Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if let Ok(uid) = uid {
        let _ = std::process::Command::new("launchctl")
            .args(["kickstart", &format!("gui/{uid}/{}", channel::current().launchd_label)])
            .output();
    }
}

fn health_loop(app: AppHandle) -> ! {
    let mut kicked = false;
    let mut last = String::new();
    loop {
        let status = match daemon::current().and_then(|c| daemon::health(&c).map(|v| (c, v))) {
            Some((c, version)) => {
                kicked = false;
                sync_windows(&app, &c);
                format!("Daemon running (v{version})")
            }
            None => {
                if !kicked && !daemon::dev_mode() {
                    kicked = true;
                    kickstart();
                }
                "Daemon offline".to_string()
            }
        };
        if status != last {
            let _ = app.state::<Shell>().status.set_text(&status);
            last = status;
        }
        // The user may flip the app's notification switch at any time.
        notify::refresh(false);
        std::thread::sleep(Duration::from_secs(5));
    }
}

fn create_windows(app: &AppHandle) -> tauri::Result<()> {
    let offline = || WebviewUrl::App("index.html".into());
    let main = WebviewWindowBuilder::new(app, "main", offline())
        .title(channel::current().product_name)
        .inner_size(1280.0, 820.0)
        .visible(false)
        .build()?;
    let h = app.clone();
    main.on_window_event(move |e| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = h.get_webview_window("main").map(|w| w.hide());
        }
    });
    let popover = WebviewWindowBuilder::new(app, "popover", offline())
        .inner_size(480.0, 600.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    let h = app.clone();
    popover.on_window_event(move |e| {
        if let tauri::WindowEvent::Focused(false) = e {
            *h.state::<Shell>().last_blur.lock().unwrap() = Some(Instant::now());
            let _ = h.get_webview_window("popover").map(|w| w.hide());
        }
    });
    Ok(())
}

/// Make `binding` (the daemon's grammar) the global "open the inbox" shortcut and
/// the tray item's accelerator. Main thread only. A binding that is off, invalid
/// or refused leaves nothing registered; the same one again does nothing.
fn apply_open_shortcut(app: &AppHandle, binding: &str) {
    let want = shortcut::to_accelerator(binding);
    let shell = app.state::<Shell>();
    let mut current = shell.open_shortcut.lock().unwrap();
    if *current == want {
        return;
    }
    if let Some(old) = current.take() {
        if let Err(e) = app.global_shortcut().unregister(old.as_str()) {
            eprintln!("global shortcut {old} not unregistered: {e}");
        }
    }
    if let Some(new) = want {
        match app.global_shortcut().register(new.as_str()) {
            Ok(()) => *current = Some(new),
            Err(e) => eprintln!("global shortcut {new} not registered: {e}"),
        }
    } else if !binding.is_empty() {
        eprintln!("global shortcut {binding:?} ignored: not a key press the shell can register");
    }
    if let Err(e) = shell.open_item.set_accelerator(current.as_deref()) {
        eprintln!("tray accelerator not updated: {e}");
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.set_activation_policy(ActivationPolicy::Accessory);
    let h = app.handle().clone();

    let ch = channel::current();
    let version = app.package_info().version.to_string();

    let open = MenuItem::with_id(&h, "open", "Open inbox", true, Some(ch.shortcut))?;
    let pause = CheckMenuItem::with_id(&h, "pause", "Pause notifications", true, false, None::<&str>)?;
    let notif_off = MenuItem::with_id(&h, "notif-settings", "Notifications are off — Open Settings…", true, None::<&str>)?;
    let status = MenuItem::with_id(&h, "status", "Daemon: checking…", false, None::<&str>)?;
    let about = MenuItem::with_id(&h, "version", format!("{} {version}", ch.product_name), false, None::<&str>)?;
    let updates = MenuItem::with_id(&h, "updates", "Check for Updates…", true, None::<&str>)?;
    let settings = MenuItem::with_id(&h, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let setup = MenuItem::with_id(&h, "setup", "Setup Check…", true, None::<&str>)?;
    let quit = MenuItem::with_id(&h, "quit", format!("Quit {}", ch.product_name), true, Some("CmdOrCtrl+Q"))?;
    let sep = || PredefinedMenuItem::separator(&h);
    let menu = Menu::with_items(&h, &[&open, &pause, &sep()?, &settings, &setup, &updates, &sep()?, &status, &about, &sep()?, &quit])?;
    app.manage(Shell {
        paused: AtomicBool::new(false),
        status,
        last_blur: Mutex::new(None),
        menu: menu.clone(),
        notif_off,
        open_item: open.clone(),
        open_shortcut: Mutex::new(None),
        notif_off_shown: AtomicBool::new(false),
        version,
    });

    // Before launch finishes, so a click that cold-started the app is delivered.
    notify::init(&h);

    create_windows(&h)?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip(channel::current().product_name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "open" => show_main(app, None),
            "notif-settings" => open_notification_settings(),
            "updates" => show_main(app, Some("#/update".into())),
            "settings" => show_main(app, Some("#/settings".into())),
            "setup" => show_main(app, Some("#/setup".into())),
            "pause" => app.state::<Shell>().paused.store(pause.is_checked().unwrap_or(false), Ordering::Relaxed),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = e {
                let scale = tray.app_handle().get_webview_window("popover").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
                let (pos, size) = (rect.position.to_physical::<f64>(scale), rect.size.to_physical::<f64>(scale));
                toggle_popover(tray.app_handle(), Some((PhysicalPosition::new(pos.x, pos.y + size.height), size.width)));
            }
        })
        .build(&h)?;

    // Non-essential from here on: log and keep going (another app may own the shortcut).
    match h.global_shortcut().register(ch.shortcut) {
        Ok(()) => *h.state::<Shell>().open_shortcut.lock().unwrap() = Some(ch.shortcut.to_string()),
        Err(e) => {
            eprintln!("global shortcut {} not registered: {e}", ch.shortcut);
            let _ = open.set_accelerator(None::<&str>);
        }
    }
    let links = h.clone();
    h.deep_link().on_open_url(move |e| {
        for hash in e.urls().iter().filter_map(|u| deep_link_hash(u.as_str())) {
            show_main(&links, Some(hash));
        }
    });

    // Login item: register once in production, never from a dev/test run.
    match h.path().app_data_dir() {
        Ok(dir) if !daemon::dev_mode() => {
            let marker = dir.join("autostart-registered");
            if !marker.exists() {
                if let Err(e) = h.autolaunch().enable() {
                    eprintln!("login item not registered: {e}");
                }
                let _ = std::fs::create_dir_all(&dir);
                let _ = std::fs::write(&marker, "");
            } else if let (Ok(true), Ok(exe), Ok(home)) = (h.autolaunch().is_enabled(), std::env::current_exe(), h.path().home_dir()) {
                // Still enabled, but written by a copy that lived elsewhere: point it here (S-022).
                let plist = home.join("Library/LaunchAgents").join(format!("{}.plist", h.package_info().name));
                let stale = std::fs::read_to_string(&plist).map(|t| login_item_is_stale(&t, &exe.to_string_lossy())).unwrap_or(false);
                if stale {
                    if let Err(e) = h.autolaunch().enable() {
                        eprintln!("login item not updated: {e}");
                    }
                }
            }
        }
        Ok(_) => {}
        Err(e) => eprintln!("no app data dir, login item skipped: {e}"),
    }

    let stream = h.clone();
    std::thread::spawn(move || {
        daemon::stream_loop(
            |_| notify::refresh(true),
            |m| match m {
                Msg::Badge(n) => set_badge(&stream, n),
                Msg::Notify(n) if !stream.state::<Shell>().paused.load(Ordering::Relaxed) || n.critical => notify::post(&n),
                Msg::Unnotify(ids) => notify::clear(&ids),
                Msg::OpenInboxShortcut(binding) => {
                    let app = stream.clone();
                    let _ = stream.run_on_main_thread(move || apply_open_shortcut(&app, &binding));
                }
                _ => {}
            },
        )
    });
    std::thread::spawn(move || health_loop(h));
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        show_main(app, None);
                    }
                })
                .build(),
        )
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("failed to build shell")
        .run(|_, e| {
            // Menu-bar app: closing windows must not quit; only the Quit item does.
            if let RunEvent::ExitRequested { api, code: None, .. } = e {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{deep_link_hash, deep_link_hash_for, login_item_is_stale};

    #[test]
    fn a_login_item_for_another_copy_is_stale() {
        let here = "/Users/me/Applications/Session Inbox.app/Contents/MacOS/session-inbox-shell";
        let plist = |exe: &str| format!("<array><string>{exe}</string></array>");
        assert!(!login_item_is_stale(&plist(here), here));
        assert!(login_item_is_stale(&plist("/repo/target/release/bundle/macos/Session Inbox.app/Contents/MacOS/session-inbox-shell"), here));
    }

    #[test]
    fn maps_deep_links_to_routes() {
        assert_eq!(deep_link_hash_for("sessioninbox://item/abc", "sessioninbox"), Some("#/item/abc".into()));
        assert_eq!(deep_link_hash_for("sessioninbox://session/s-1/", "sessioninbox"), Some("#/session/s-1".into()));
        assert_eq!(deep_link_hash_for("sessioninbox://other/abc", "sessioninbox"), None);
        assert_eq!(deep_link_hash("https://item/abc"), None);
        assert_eq!(deep_link_hash_for("sessioninbox-beta://item/abc", "sessioninbox-beta"), Some("#/item/abc".into()));
        assert_eq!(deep_link_hash_for("sessioninbox-beta://item/abc", "sessioninbox"), None);
        assert_eq!(deep_link_hash_for("sessioninbox://item", "sessioninbox"), None);
    }
}
