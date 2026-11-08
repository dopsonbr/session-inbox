//! Native notifications via mac-notification-sys (blocking NSUserNotification
//! delegate), because tauri-plugin-notification has no click/action callbacks on macOS.
use crate::daemon::{self, NotifyPayload};
use mac_notification_sys::{MainButton, Notification, NotificationResponse};
use tauri::AppHandle;

pub fn init() {
    if let Err(e) = mac_notification_sys::set_application("com.sessioninbox.app") {
        eprintln!("notification setup failed: {e}");
    }
}

fn label(action: &str) -> Option<&'static str> {
    match action {
        "answer" => Some("Answer"),
        "allow" => Some("Allow"),
        "deny" => Some("Deny"),
        "open" => Some("Open"),
        _ => None,
    }
}

/// Post `n` and wait (on its own thread) for the user's click or action.
pub fn post(app: &AppHandle, n: NotifyPayload) {
    let app = app.clone();
    std::thread::spawn(move || {
        let labels: Vec<&str> = n.actions.iter().filter_map(|a| label(a)).collect();
        let mut note = Notification::new();
        note.title(&n.title).message(&n.body).default_sound().wait_for_click(true).close_button("Dismiss");
        match labels.as_slice() {
            [] => {}
            [one] => {
                note.main_button(MainButton::SingleAction(one));
            }
            many => {
                note.main_button(MainButton::DropdownActions("Actions", many));
            }
        }
        let action = match note.send() {
            Ok(NotificationResponse::Click) => "click".to_string(),
            Ok(NotificationResponse::ActionButton(name)) => name.to_lowercase(),
            Ok(_) => return,
            Err(e) => return eprintln!("notification failed: {e}"),
        };
        let Some(c) = daemon::current() else { return };
        daemon::acted(&c, &n.id, &action);
        // allow/deny are answered in place; everything else brings the app forward.
        if action != "allow" && action != "deny" {
            crate::show_main(&app, Some(format!("#/item/{}", n.item_id)));
        }
    });
}
