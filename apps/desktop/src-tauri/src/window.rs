//! Which surface a click lands on, and where the inbox window sits (S-027 to S-032).
//! Only the pure parts and the state file live here; `main.rs` does the windowing.
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::Url;

/// The daemon's `app.opens` setting (contracts `AppOpens`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opens {
    Window,
    Popover,
    WindowFirst,
}

impl Opens {
    /// `None` for a value this build doesn't know: the current choice stands.
    pub fn parse(s: &str) -> Option<Opens> {
        match s {
            "window" => Some(Opens::Window),
            "popover" => Some(Opens::Popover),
            "windowFirst" => Some(Opens::WindowFirst),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Window,
    Popover,
}

/// A notification click or a deep link to an item.
pub fn item_surface(opens: Opens) -> Surface {
    match opens {
        Opens::Popover => Surface::Popover,
        Opens::Window | Opens::WindowFirst => Surface::Window,
    }
}

/// A click on the menu-bar icon. `window_open`: the inbox window is on screen or minimised.
pub fn icon_surface(opens: Opens, window_open: bool) -> Surface {
    match opens {
        Opens::WindowFirst if window_open => Surface::Window,
        _ => Surface::Popover,
    }
}

/// A link followed inside the popover. `None`: its own page, let it load. `Some(hash)`:
/// a route of the full inbox (`""` for none), which belongs in the inbox window (U-012).
pub fn popover_link(url: &Url) -> Option<String> {
    let local = url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    let compact = url.query_pairs().any(|(k, v)| k == "view" && v == "compact");
    (local && !compact).then(|| url.fragment().map(|f| format!("#{f}")).unwrap_or_default())
}

/// The app became frontmost (⌘Tab, mostly). Bring the inbox window back only when nothing
/// of ours is showing and nothing else is about to show something.
pub fn restore_on_activate(active: bool, window_open: bool, popover_open: bool, just_asked: bool, launching: bool) -> bool {
    active && !window_open && !popover_open && !just_asked && !launching
}

/// The inbox window as it was left, in points (so it means the same on any display).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

/// A display's frame in points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const MIN_WIDTH: f64 = 480.0;
const MIN_HEIGHT: f64 = 320.0;
/// The strip you drag a window by, and how much of it has to be on a display.
const TITLE_BAR: f64 = 28.0;
const GRAB_WIDTH: f64 = 120.0;

/// Can the window be reached where it was saved? False when its display is gone (or the
/// file is nonsense); the window then opens at the default place.
pub fn reachable(s: &Saved, screens: &[Screen]) -> bool {
    let sane = [s.x, s.y, s.width, s.height].iter().all(|v| v.is_finite()) && s.width >= MIN_WIDTH && s.height >= MIN_HEIGHT;
    sane && screens.iter().any(|d| {
        let across = (s.x + s.width).min(d.x + d.width) - s.x.max(d.x);
        let down = (s.y + TITLE_BAR).min(d.y + d.height) - s.y.max(d.y);
        across >= GRAB_WIDTH.min(s.width) && down >= TITLE_BAR / 2.0
    })
}

const FILE: &str = "window.json";

pub fn load(dir: &Path) -> Option<Saved> {
    serde_json::from_slice(&std::fs::read(dir.join(FILE)).ok()?).ok()
}

/// Best effort: a state file that can't be written only costs the remembered place.
pub fn save(dir: &Path, s: &Saved) {
    let _ = std::fs::create_dir_all(dir);
    if let Err(e) = std::fs::write(dir.join(FILE), serde_json::to_vec(s).unwrap_or_default()) {
        eprintln!("window state not saved: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Screen = Screen { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    const SECOND: Screen = Screen { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 };

    fn saved(x: f64, y: f64) -> Saved {
        Saved { x, y, width: 1280.0, height: 820.0, visible: true }
    }

    #[test]
    fn reads_the_setting() {
        assert_eq!(Opens::parse("window"), Some(Opens::Window));
        assert_eq!(Opens::parse("popover"), Some(Opens::Popover));
        assert_eq!(Opens::parse("windowFirst"), Some(Opens::WindowFirst));
        assert_eq!(Opens::parse("dock"), None);
    }

    #[test]
    fn routes_clicks_by_the_setting() {
        assert_eq!(item_surface(Opens::Window), Surface::Window);
        assert_eq!(item_surface(Opens::Popover), Surface::Popover);
        assert_eq!(item_surface(Opens::WindowFirst), Surface::Window);
        for open in [true, false] {
            assert_eq!(icon_surface(Opens::Window, open), Surface::Popover);
            assert_eq!(icon_surface(Opens::Popover, open), Surface::Popover);
        }
        assert_eq!(icon_surface(Opens::WindowFirst, true), Surface::Window);
        assert_eq!(icon_surface(Opens::WindowFirst, false), Surface::Popover);
    }

    #[test]
    fn popover_links_to_the_full_inbox_go_to_the_window() {
        let link = |u: &str| popover_link(&Url::parse(u).unwrap());
        assert_eq!(link("http://127.0.0.1:5123/?view=compact&k=abc"), None);
        assert_eq!(link("http://127.0.0.1:5123/?view=compact#/item/i-1"), None);
        assert_eq!(link("http://127.0.0.1:5123/#/item/i-1"), Some("#/item/i-1".into()));
        assert_eq!(link("http://127.0.0.1:5123/"), Some(String::new()));
        assert_eq!(link("tauri://localhost/index.html"), None);
        assert_eq!(link("https://github.com/dopsonbr/session-inbox/releases"), None);
    }

    #[test]
    fn activation_restores_the_window_only_when_nothing_is_showing() {
        assert!(restore_on_activate(true, false, false, false, false));
        assert!(!restore_on_activate(false, false, false, false, false));
        assert!(!restore_on_activate(true, true, false, false, false));
        assert!(!restore_on_activate(true, false, true, false, false));
        assert!(!restore_on_activate(true, false, false, true, false));
        assert!(!restore_on_activate(true, false, false, false, true));
    }

    #[test]
    fn a_window_on_a_missing_display_is_not_reachable() {
        assert!(reachable(&saved(100.0, 60.0), &[LAPTOP]));
        assert!(reachable(&saved(1800.0, 100.0), &[LAPTOP, SECOND]));
        assert!(!reachable(&saved(1800.0, 100.0), &[LAPTOP]));
        // Mostly off the left edge, but enough title bar left to drag it back.
        assert!(reachable(&saved(-1100.0, 40.0), &[LAPTOP]));
        assert!(!reachable(&saved(-1250.0, 40.0), &[LAPTOP]));
        // Title bar above or below every display.
        assert!(!reachable(&saved(100.0, -400.0), &[LAPTOP]));
        assert!(!reachable(&saved(100.0, 990.0), &[LAPTOP]));
        assert!(!reachable(&saved(100.0, 60.0), &[]));
    }

    #[test]
    fn nonsense_sizes_are_not_restored() {
        let tiny = Saved { width: 10.0, ..saved(100.0, 60.0) };
        let nan = Saved { x: f64::NAN, ..saved(100.0, 60.0) };
        assert!(!reachable(&tiny, &[LAPTOP]));
        assert!(!reachable(&nan, &[LAPTOP]));
    }

    #[test]
    fn state_round_trips_and_a_bad_file_is_ignored() {
        let dir = std::env::temp_dir().join(format!("si-window-{}", std::process::id()));
        assert_eq!(load(&dir), None);
        save(&dir, &saved(12.5, 40.0));
        assert_eq!(load(&dir), Some(saved(12.5, 40.0)));
        std::fs::write(dir.join(FILE), "{").unwrap();
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
