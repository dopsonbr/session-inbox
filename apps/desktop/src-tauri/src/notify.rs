//! Native notifications through UNUserNotificationCenter (UserNotifications.framework).
//! The delegate is installed during Tauri's `setup`, which tao runs inside
//! `applicationDidFinishLaunching`, so a click that cold-starts the app still
//! reaches it. Nothing here blocks: every framework call takes a completion block.
use crate::daemon::NotifyPayload;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::collections::BTreeSet;
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

pub const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";
pub const DISMISS_ACTION: &str = "com.apple.UNNotificationDismissActionIdentifier";

/// The action sets the daemon sends today; registered up front so the first
/// notification of each kind already has its buttons.
pub const KNOWN_SETS: [&[&str]; 3] = [&["allow", "deny", "open"], &["answer", "open"], &["open"]];

/// What the shell may do, in the `/v1/shell/status` vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    pub notifications: &'static str,
    pub alert_style: &'static str,
}

impl Settings {
    pub const UNKNOWN: Settings = Settings { notifications: "unknown", alert_style: "unknown" };

    pub fn allowed(&self) -> bool {
        matches!(self.notifications, "authorized" | "provisional")
    }
}

/// `UNAuthorizationStatus` raw value -> status name.
pub fn status_name(raw: isize) -> &'static str {
    match raw {
        0 => "notDetermined",
        1 => "denied",
        2 => "authorized",
        3 => "provisional",
        _ => "unknown", // 4 = ephemeral (App Clips only) or anything newer
    }
}

/// `UNAlertStyle` raw value -> style name.
pub fn alert_style_name(raw: isize) -> &'static str {
    match raw {
        0 => "none",
        1 => "banner",
        2 => "alert",
        _ => "unknown",
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ActionSpec {
    pub title: &'static str,
    /// Bring the app forward when chosen (`UNNotificationActionOptionForeground`).
    pub foreground: bool,
    pub destructive: bool,
}

pub fn action_spec(action: &str) -> Option<ActionSpec> {
    let (title, foreground, destructive) = match action {
        "allow" => ("Allow", false, false),
        "deny" => ("Deny", false, true),
        "answer" => ("Answer", true, false),
        "open" => ("Open", true, false),
        _ => return None,
    };
    Some(ActionSpec { title, foreground, destructive })
}

/// The known actions of a set, in order.
fn known(actions: &[String]) -> Vec<String> {
    actions.iter().filter(|a| action_spec(a).is_some()).cloned().collect()
}

/// `[allow, deny, open]` -> `si.allow-deny-open`; no known action -> no category.
pub fn category_id(actions: &[String]) -> Option<String> {
    let k = known(actions);
    (!k.is_empty()).then(|| format!("si.{}", k.join("-")))
}

/// A response's action identifier -> the daemon's `acted` action (None: ignore).
pub fn response_action(identifier: &str) -> Option<&'static str> {
    match identifier {
        DEFAULT_ACTION => Some("click"),
        "answer" => Some("answer"),
        "allow" => Some("allow"),
        "deny" => Some("deny"),
        "open" => Some("open"),
        _ => None, // dismiss, or something we never registered
    }
}

/// allow/deny are answered in place; everything else brings the app forward.
pub fn opens_window(action: &str) -> bool {
    action != "allow" && action != "deny"
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static AVAILABLE: OnceLock<bool> = OnceLock::new();
static SETTINGS: Mutex<Option<Settings>> = Mutex::new(None);
static CATEGORIES: Mutex<BTreeSet<Vec<String>>> = Mutex::new(BTreeSet::new());

/// UNUserNotificationCenter raises when the process has no app bundle (e.g. `cargo run`).
fn available() -> bool {
    *AVAILABLE.get_or_init(|| {
        let b = NSBundle::mainBundle();
        let id = b.bundleIdentifier().map(|s| s.to_string());
        let ok = id.is_some() && b.bundlePath().to_string().ends_with(".app");
        if !ok {
            eprintln!("notifications unavailable: not running from an .app bundle");
        } else if id.as_deref() != Some(crate::channel::current().identifier) {
            eprintln!("bundle id {id:?} does not match this build's channel; notifications go to that app");
        }
        ok
    })
}

fn center() -> Option<Retained<UNUserNotificationCenter>> {
    available().then(UNUserNotificationCenter::currentNotificationCenter)
}

pub fn current_settings() -> Settings {
    SETTINGS.lock().unwrap().unwrap_or(Settings::UNKNOWN)
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and Delegate has no Drop.
    #[unsafe(super(NSObject))]
    #[name = "SessionInboxNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Show it even while one of our windows is frontmost.
            done.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            done: &block2::DynBlock<dyn Fn()>,
        ) {
            on_response(response);
            done.call(());
        }
    }
);

fn on_response(r: &UNNotificationResponse) {
    let identifier = r.actionIdentifier().to_string();
    let request = r.notification().request();
    let id = request.identifier().to_string();
    let item_id = request.content().threadIdentifier().to_string();
    eprintln!("notification {id}: response {identifier}");
    let Some(action) = response_action(&identifier) else { return };
    let Some(app) = APP.get().cloned() else { return };
    // Off the delegate's queue: the HTTP call must not hold up the system.
    let opens = opens_window(action) && !item_id.is_empty();
    if opens {
        // The click also makes the app frontmost: say now that something is about to open.
        crate::mark_request(&app);
    }
    std::thread::spawn(move || {
        if let Some(c) = crate::daemon::current() {
            crate::daemon::acted(&c, &id, action);
        }
        if opens {
            crate::open_item(&app, format!("#/item/{item_id}"));
        }
    });
}

/// Install the delegate, register categories and ask for permission. Call on
/// the main thread from `setup`, i.e. before launch finishes.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(center) = center() else {
        *SETTINGS.lock().unwrap() = Some(Settings::UNKNOWN);
        return;
    };
    // SAFETY: framework-provided constant NSStrings, valid for the process lifetime.
    let (default_id, dismiss_id) =
        unsafe { (UNNotificationDefaultActionIdentifier.to_string(), UNNotificationDismissActionIdentifier.to_string()) };
    if default_id != DEFAULT_ACTION || dismiss_id != DISMISS_ACTION {
        eprintln!("unexpected UN action identifiers; clicks may be ignored");
    }
    let delegate: Retained<Delegate> = unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; this one lives for the whole process.
    std::mem::forget(delegate);

    {
        let mut sets = CATEGORIES.lock().unwrap();
        for set in KNOWN_SETS {
            sets.insert(set.iter().map(|s| s.to_string()).collect());
        }
        register_categories(&center, &sets);
    }

    let done = RcBlock::new(|granted: Bool, err: *mut NSError| {
        let err = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
        eprintln!("notification authorization: granted={} error={err:?}", granted.as_bool());
        refresh(true);
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
        &done,
    );
}

fn build_category(set: &[String]) -> Option<Retained<UNNotificationCategory>> {
    let id = category_id(set)?;
    let actions: Vec<Retained<UNNotificationAction>> = set
        .iter()
        .filter_map(|a| action_spec(a).map(|s| (a, s)))
        .map(|(a, s)| {
            let mut opts = UNNotificationActionOptions::empty();
            if s.foreground {
                opts |= UNNotificationActionOptions::Foreground;
            }
            if s.destructive {
                opts |= UNNotificationActionOptions::Destructive;
            }
            UNNotificationAction::actionWithIdentifier_title_options(&NSString::from_str(a), &NSString::from_str(s.title), opts)
        })
        .collect();
    Some(UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(&id),
        &NSArray::from_retained_slice(&actions),
        &NSArray::new(),
        UNNotificationCategoryOptions::empty(),
    ))
}

/// `setNotificationCategories` replaces the whole set, so always pass all of them.
fn register_categories(center: &UNUserNotificationCenter, sets: &BTreeSet<Vec<String>>) {
    let cats: Vec<_> = sets.iter().filter_map(|s| build_category(s)).collect();
    center.setNotificationCategories(&NSSet::from_retained_slice(&cats));
}

fn ensure_category(center: &UNUserNotificationCenter, actions: &[String]) {
    let k = known(actions);
    if k.is_empty() {
        return;
    }
    let mut sets = CATEGORIES.lock().unwrap();
    if sets.insert(k) {
        register_categories(center, &sets);
    }
}

/// Post one notification. Still attempted while not allowed (harmless), but
/// then it is logged as not shown rather than as delivered.
pub fn post(n: &NotifyPayload) {
    let Some(center) = center() else {
        return eprintln!("notification {} dropped: no app bundle", n.id);
    };
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&n.title));
    content.setBody(&NSString::from_str(&n.body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    content.setThreadIdentifier(&NSString::from_str(&n.item_id));
    if let Some(cat) = category_id(&n.actions) {
        ensure_category(&center, &n.actions);
        content.setCategoryIdentifier(&NSString::from_str(&cat));
    }
    let keys = [NSString::from_str("id"), NSString::from_str("itemId")];
    let values = [NSString::from_str(&n.id), NSString::from_str(&n.item_id)];
    let info = NSDictionary::<NSString, NSString>::from_slices(&[&*keys[0], &*keys[1]], &[&*values[0], &*values[1]]);
    // SAFETY: userInfo is a property-list dictionary; NSString keys and values qualify.
    unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&n.id), &content, None);
    let id = n.id.clone();
    let done = RcBlock::new(move |err: *mut NSError| match unsafe { err.as_ref() } {
        Some(e) => eprintln!("notification {id} failed: {}", e.localizedDescription()),
        None => {
            let s = current_settings();
            if s.allowed() {
                eprintln!("notification {id} added ({})", s.notifications);
            } else {
                eprintln!("notification {id} added but not shown: notifications are {}", s.notifications);
            }
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

/// Remove delivered (and still pending) notifications, e.g. once answered elsewhere.
pub fn clear(ids: &[String]) {
    let Some(center) = center() else { return };
    let ids: Vec<Retained<NSString>> = ids.iter().map(|i| NSString::from_str(i)).collect();
    let arr = NSArray::from_retained_slice(&ids);
    center.removeDeliveredNotificationsWithIdentifiers(&arr);
    center.removePendingNotificationRequestsWithIdentifiers(&arr);
}

/// Re-read the system settings; on a change (or when `force`d) tell the shell.
pub fn refresh(force: bool) {
    let Some(center) = center() else {
        if force {
            if let Some(app) = APP.get() {
                crate::notifications_changed(app, Settings::UNKNOWN, true);
            }
        }
        return;
    };
    let done = RcBlock::new(move |s: NonNull<UNNotificationSettings>| {
        let s = unsafe { s.as_ref() };
        let next = Settings {
            notifications: status_name(s.authorizationStatus().0),
            alert_style: alert_style_name(s.alertStyle().0),
        };
        let prev = SETTINGS.lock().unwrap().replace(next);
        let changed = prev != Some(next);
        if changed {
            eprintln!("notification settings: {next:?}");
        }
        if let Some(app) = APP.get() {
            crate::notifications_changed(app, next, force || changed);
        }
    });
    center.getNotificationSettingsWithCompletionHandler(&done);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn maps_status_and_style() {
        assert_eq!(status_name(0), "notDetermined");
        assert_eq!(status_name(1), "denied");
        assert_eq!(status_name(2), "authorized");
        assert_eq!(status_name(3), "provisional");
        assert_eq!(status_name(4), "unknown");
        assert_eq!(alert_style_name(0), "none");
        assert_eq!(alert_style_name(1), "banner");
        assert_eq!(alert_style_name(2), "alert");
        assert_eq!(alert_style_name(9), "unknown");
        assert!(Settings { notifications: "provisional", alert_style: "banner" }.allowed());
        assert!(!Settings { notifications: "notDetermined", alert_style: "alert" }.allowed());
        assert!(!Settings::UNKNOWN.allowed());
    }

    #[test]
    fn category_ids_follow_action_sets() {
        assert_eq!(category_id(&v(&["allow", "deny", "open"])).as_deref(), Some("si.allow-deny-open"));
        assert_eq!(category_id(&v(&["answer", "open"])).as_deref(), Some("si.answer-open"));
        assert_eq!(category_id(&v(&["open"])).as_deref(), Some("si.open"));
        assert_eq!(category_id(&v(&["open", "bogus"])).as_deref(), Some("si.open"));
        assert_eq!(category_id(&v(&[])), None);
        assert_eq!(category_id(&v(&["click"])), None);
    }

    #[test]
    fn action_options() {
        let allow = action_spec("allow").unwrap();
        let deny = action_spec("deny").unwrap();
        assert_eq!((allow.title, allow.foreground, allow.destructive), ("Allow", false, false));
        assert_eq!((deny.title, deny.foreground, deny.destructive), ("Deny", false, true));
        assert!(action_spec("answer").unwrap().foreground);
        assert!(action_spec("open").unwrap().foreground);
        assert_eq!(action_spec("click"), None);
    }

    #[test]
    fn maps_responses_to_acted_actions() {
        assert_eq!(response_action(DEFAULT_ACTION), Some("click"));
        assert_eq!(response_action(DISMISS_ACTION), None);
        for a in ["answer", "allow", "deny", "open"] {
            assert_eq!(response_action(a), Some(a));
        }
        assert_eq!(response_action("Allow"), None);
        assert!(opens_window("click") && opens_window("open") && opens_window("answer"));
        assert!(!opens_window("allow") && !opens_window("deny"));
    }
}
