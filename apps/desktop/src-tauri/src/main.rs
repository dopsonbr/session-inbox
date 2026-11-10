//! Session Inbox shell: menu-bar bridge for the daemon. It renders nothing itself;
//! its windows load the daemon-served UI, and it only relays notifications,
//! the badge, deep links and the global shortcut.
mod channel;
mod daemon;
mod notify;

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

const WINDOWS: [(&str, &str); 2] = [("main", "/"), ("popover", "/?view=compact")];

struct Shell {
    paused: AtomicBool,
    status: MenuItem<Wry>,
    last_blur: Mutex<Option<Instant>>,
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
    for (label, path) in WINDOWS {
        if let Some(w) = app.get_webview_window(label) {
            if !on_daemon_origin(&w, c) {
                let _ = w.navigate(format!("{}{path}", c.base()).parse().unwrap());
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
            let _ = w.navigate(format!("{}/{h}", c.base()).parse().unwrap());
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

/// Ask launchd to (re)start the daemon agent. Never spawns it as a child.
fn kickstart() {
    let uid = std::process::Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if let Ok(uid) = uid {
        let _ = std::process::Command::new("launchctl")
            .args(["kickstart", "-k", &format!("gui/{uid}/{}", channel::current().launchd_label)])
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

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.set_activation_policy(ActivationPolicy::Accessory);
    let h = app.handle().clone();

    let open = MenuItem::with_id(&h, "open", "Open inbox", true, Some(channel::current().shortcut))?;
    let pause = CheckMenuItem::with_id(&h, "pause", "Pause notifications", true, false, None::<&str>)?;
    let status = MenuItem::with_id(&h, "status", "Daemon: checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(&h, "quit", format!("Quit {}", channel::current().product_name), true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        &h,
        &[&open, &pause, &PredefinedMenuItem::separator(&h)?, &status, &PredefinedMenuItem::separator(&h)?, &quit],
    )?;
    app.manage(Shell { paused: AtomicBool::new(false), status, last_blur: Mutex::new(None) });

    create_windows(&h)?;
    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip(channel::current().product_name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "open" => show_main(app, None),
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

    h.global_shortcut().register(channel::current().shortcut)?;
    let links = h.clone();
    h.deep_link().on_open_url(move |e| {
        for hash in e.urls().iter().filter_map(|u| deep_link_hash(u.as_str())) {
            show_main(&links, Some(hash));
        }
    });

    // Login item: register once in production, never from a dev/test run.
    let marker = h.path().app_data_dir()?.join("autostart-registered");
    if !daemon::dev_mode() && !marker.exists() {
        let _ = h.autolaunch().enable();
        let _ = std::fs::create_dir_all(marker.parent().unwrap());
        let _ = std::fs::write(&marker, "");
    }

    notify::init();
    let stream = h.clone();
    std::thread::spawn(move || {
        daemon::stream_loop(|m| match m {
            Msg::Badge(n) => set_badge(&stream, n),
            Msg::Notify(n) if !stream.state::<Shell>().paused.load(Ordering::Relaxed) || n.critical => notify::post(&stream, n),
            _ => {}
        })
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
    use super::{deep_link_hash, deep_link_hash_for};

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
