//! Per-channel constants. The channel is fixed at compile time by
//! `SESSION_INBOX_CHANNEL` (`beta`; anything else or unset is ga), so a beta
//! build can run beside the ga one without sharing data, launchd job, bundle id,
//! URL scheme or shortcut.

pub struct Channel {
    /// `ga` or `beta`, as reported to the daemon.
    pub name: &'static str,
    /// Directory under `~/Library/Application Support` (default data home).
    pub support_dir: &'static str,
    pub launchd_label: &'static str,
    pub identifier: &'static str,
    pub scheme: &'static str,
    pub shortcut: &'static str,
    pub product_name: &'static str,
}

pub const GA: Channel = Channel {
    name: "ga",
    support_dir: "SessionInbox",
    launchd_label: "com.sessioninbox.inboxd",
    identifier: "com.sessioninbox.app",
    scheme: "sessioninbox",
    shortcut: "CmdOrCtrl+Shift+I",
    product_name: "Session Inbox",
};

pub const BETA: Channel = Channel {
    name: "beta",
    support_dir: "SessionInbox-beta",
    launchd_label: "com.sessioninbox.inboxd.beta",
    identifier: "com.sessioninbox.app.beta",
    scheme: "sessioninbox-beta",
    shortcut: "CmdOrCtrl+Alt+Shift+I",
    product_name: "Session Inbox Beta",
};

pub fn for_name(name: Option<&str>) -> &'static Channel {
    if name == Some("beta") {
        &BETA
    } else {
        &GA
    }
}

pub fn current() -> &'static Channel {
    for_name(option_env!("SESSION_INBOX_CHANNEL"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_beta_selects_beta() {
        assert_eq!(for_name(Some("beta")).identifier, "com.sessioninbox.app.beta");
        assert_eq!(for_name(None).identifier, "com.sessioninbox.app");
        assert_eq!(for_name(Some("ga")).identifier, "com.sessioninbox.app");
        assert_eq!(for_name(Some("Beta")).identifier, "com.sessioninbox.app");
        assert_eq!((GA.name, BETA.name), ("ga", "beta"));
    }

    #[test]
    fn channels_do_not_collide() {
        assert_ne!(GA.support_dir, BETA.support_dir);
        assert_ne!(GA.launchd_label, BETA.launchd_label);
        assert_ne!(GA.identifier, BETA.identifier);
        assert_ne!(GA.scheme, BETA.scheme);
        assert_ne!(GA.shortcut, BETA.shortcut);
        assert_ne!(GA.product_name, BETA.product_name);
    }

    #[test]
    fn ga_matches_shipped_values() {
        assert_eq!(GA.support_dir, "SessionInbox");
        assert_eq!(GA.launchd_label, "com.sessioninbox.inboxd");
        assert_eq!(GA.scheme, "sessioninbox");
        assert_eq!(GA.shortcut, "CmdOrCtrl+Shift+I");
        assert_eq!(GA.product_name, "Session Inbox");
    }

    #[test]
    fn current_follows_build_env() {
        let expected = if option_env!("SESSION_INBOX_CHANNEL") == Some("beta") { &BETA } else { &GA };
        assert_eq!(current().identifier, expected.identifier);
    }
}
