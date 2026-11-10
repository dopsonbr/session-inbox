//! Converts the daemon's key-press grammar (`Mod+Shift+I`) to the accelerator
//! string `tauri-plugin-global-shortcut` and the tray menu parse.

/// `""` (off) and anything outside the grammar give `None`. The grammar is
/// modifiers in the order `Mod`, `Control`, `Alt`, `Shift`, then one key: a
/// letter, a digit or F1–F12. At least one of Mod/Control/Alt is required so a
/// bare or Shift-only key can never hijack typing system-wide.
///
/// `Mod` becomes `CmdOrCtrl`: global-hotkey 0.8 parses it as ⌘ on macOS (Ctrl
/// elsewhere), and it is what the channel defaults already use.
pub fn to_accelerator(binding: &str) -> Option<String> {
    const ORDER: [&str; 4] = ["Mod", "Control", "Alt", "Shift"];
    let mut parts: Vec<&str> = binding.split('+').collect();
    let key = parts.pop()?;
    let valid_key = match key.as_bytes() {
        [c] => c.is_ascii_uppercase() || c.is_ascii_digit(),
        [b'F', rest @ ..] => {
            !rest.is_empty()
                && rest[0] != b'0'
                && rest.iter().all(u8::is_ascii_digit)
                && matches!(key[1..].parse::<u8>(), Ok(1..=12))
        }
        _ => false,
    };
    if !valid_key || parts.is_empty() || parts.len() > ORDER.len() {
        return None;
    }
    let mut last = None;
    let mut out = Vec::with_capacity(parts.len() + 1);
    for m in &parts {
        let idx = ORDER.iter().position(|o| o == m)?;
        if last.is_some_and(|l| idx <= l) {
            return None;
        }
        last = Some(idx);
        out.push(match *m {
            "Mod" => "CmdOrCtrl",
            other => other,
        });
    }
    if !parts.iter().any(|m| matches!(*m, "Mod" | "Control" | "Alt")) {
        return None;
    }
    out.push(key);
    Some(out.join("+"))
}

#[cfg(test)]
mod tests {
    use super::to_accelerator;

    #[test]
    fn maps_modifiers_and_keys() {
        assert_eq!(to_accelerator("Mod+Shift+I").as_deref(), Some("CmdOrCtrl+Shift+I"));
        assert_eq!(to_accelerator("Mod+Control+Alt+Shift+9").as_deref(), Some("CmdOrCtrl+Control+Alt+Shift+9"));
        assert_eq!(to_accelerator("Control+F12").as_deref(), Some("Control+F12"));
        assert_eq!(to_accelerator("Alt+F1").as_deref(), Some("Alt+F1"));
    }

    #[test]
    fn rejects_off_and_anything_outside_the_grammar() {
        for bad in [
            "", "Mod", "Mod+", "I", "Shift+I", "Mod+i", "Mod+Enter", "Mod+,", "Mod+F0", "Mod+F13", "Mod+F01", "Mod+10", "Mod+II", "Cmd+I", "Mod+Mod+I", "Shift+Mod+I", "Mod+Shift+Alt+I", "Mod+I+J",
            "Mod + I", "Super+I", "Mod+É",
        ] {
            assert_eq!(to_accelerator(bad), None, "{bad:?}");
        }
    }
}
