fn main() {
    println!("cargo:rerun-if-env-changed=SESSION_INBOX_CHANNEL");
    tauri_build::build()
}
