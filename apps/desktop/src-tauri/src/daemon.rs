//! Everything the shell knows about the daemon: connection.json, health, the SSE
//! stream and the one write it makes (notification acted). No domain types.
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// `connection.json`, written 0600 by the daemon (contracts `Connection`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub http_port: u16,
    pub token: String,
}

impl Connection {
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.http_port)
    }
    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

/// `SESSION_INBOX_HOME` set means a dev/test daemon: no launchd, no login item.
pub fn dev_mode() -> bool {
    std::env::var_os("SESSION_INBOX_HOME").is_some()
}

pub fn home_dir() -> PathBuf {
    match std::env::var_os("SESSION_INBOX_HOME") {
        Some(p) => PathBuf::from(p),
        None => PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Application Support")
            .join(crate::channel::current().support_dir),
    }
}

pub fn read_connection(dir: &Path) -> Option<Connection> {
    serde_json::from_slice(&std::fs::read(dir.join("connection.json")).ok()?).ok()
}

/// Re-read every time: the port changes whenever the daemon restarts.
pub fn current() -> Option<Connection> {
    read_connection(&home_dir())
}

/// The slice of contracts `NotifyPayload` the shell needs.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotifyPayload {
    pub id: String,
    pub item_id: String,
    pub title: String,
    pub body: String,
    pub actions: Vec<String>,
    pub critical: bool,
}

#[derive(Debug, PartialEq)]
pub enum Msg {
    Badge(u32),
    Notify(NotifyPayload),
    Other,
}

pub fn parse_message(data: &str) -> Msg {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return Msg::Other;
    };
    match v["_tag"].as_str() {
        Some("badge") => Msg::Badge(v["count"].as_u64().unwrap_or(0) as u32),
        Some("notify") => serde_json::from_value(v["notification"].clone())
            .map(Msg::Notify)
            .unwrap_or(Msg::Other),
        _ => Msg::Other,
    }
}

#[derive(Debug, PartialEq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub data: String,
}

/// Line-at-a-time SSE parser: `id:`/`data:` fields, `:` comments ignored,
/// a blank line dispatches the event.
#[derive(Default)]
pub struct SseParser {
    id: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn feed(&mut self, line: &str) -> Option<SseEvent> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            if self.data.is_empty() {
                self.id = None;
                return None;
            }
            return Some(SseEvent { id: self.id.take(), data: std::mem::take(&mut self.data).join("\n") });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => self.data.push(value.to_string()),
            "id" => self.id = Some(value.to_string()),
            _ => {}
        }
        None
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(3)))
        .timeout_recv_body(Some(timeout))
        .timeout_global(None)
        .build()
        .into()
}

/// Unauthenticated liveness check. Returns the daemon version.
pub fn health(c: &Connection) -> Option<String> {
    let mut resp = agent(Duration::from_secs(3)).get(format!("{}/v1/health", c.base())).call().ok()?;
    let v: serde_json::Value = resp.body_mut().read_json().ok()?;
    v["ok"].as_bool()?.then(|| v["version"].as_str().unwrap_or("?").to_string())
}

/// Report a click/action on a native notification to the daemon.
pub fn acted(c: &Connection, notification_id: &str, action: &str) {
    let url = format!("{}/v1/notifications/{}/acted", c.base(), notification_id);
    let r = agent(Duration::from_secs(5))
        .post(url)
        .header("Authorization", c.auth())
        .send_json(serde_json::json!({ "action": action }));
    if let Err(e) = r {
        eprintln!("acted({action}) failed: {e}");
    }
}

/// Read one SSE connection until it ends. Returns whether it connected at all.
fn stream_once(c: &Connection, on_msg: &mut impl FnMut(Msg)) -> bool {
    let resp = agent(Duration::from_secs(90))
        .get(format!("{}/v1/stream?client=shell", c.base()))
        .header("Authorization", c.auth())
        .header("Accept", "text/event-stream")
        .call();
    let Ok(resp) = resp else { return false };
    if !resp.status().is_success() {
        return false;
    }
    let mut parser = SseParser::default();
    for line in BufReader::new(resp.into_body().into_reader()).lines() {
        let Ok(line) = line else { break };
        if let Some(ev) = parser.feed(&line) {
            on_msg(parse_message(&ev.data));
        }
    }
    true
}

/// Connect, stream, reconnect forever with 1s..15s backoff, re-reading connection.json each time.
pub fn stream_loop(mut on_msg: impl FnMut(Msg)) -> ! {
    let mut backoff = 1;
    loop {
        if let Some(c) = current() {
            if stream_once(&c, &mut on_msg) {
                backoff = 1;
            }
        }
        std::thread::sleep(Duration::from_secs(backoff));
        backoff = (backoff * 2).min(15);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(input: &str) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        input.split_inclusive('\n').filter_map(|l| p.feed(l)).collect()
    }

    #[test]
    fn parses_events_ids_and_ignores_heartbeats() {
        let evs = feed_all(": hb\n\nid: 7\ndata: {\"a\":1}\n\n: hb\ndata:x\ndata: y\r\n\r\n");
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0], SseEvent { id: Some("7".into()), data: "{\"a\":1}".into() });
        assert_eq!(evs[1], SseEvent { id: None, data: "x\ny".into() });
    }

    #[test]
    fn parses_stream_messages() {
        assert_eq!(parse_message(r#"{"_tag":"badge","seq":1,"count":3}"#), Msg::Badge(3));
        assert_eq!(parse_message(r#"{"_tag":"hello","seq":1}"#), Msg::Other);
        assert_eq!(parse_message("nonsense"), Msg::Other);
        let n = r#"{"_tag":"notify","seq":2,"notification":{"id":"n1","itemId":"i1","title":"T","body":"B","actions":["allow","deny","open"],"critical":false}}"#;
        match parse_message(n) {
            Msg::Notify(p) => {
                assert_eq!((p.id.as_str(), p.item_id.as_str()), ("n1", "i1"));
                assert_eq!(p.actions, ["allow", "deny", "open"]);
            }
            m => panic!("{m:?}"),
        }
    }

    #[test]
    fn reads_connection_json() {
        let dir = std::env::temp_dir().join(format!("si-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_connection(&dir), None);
        std::fs::write(
            dir.join("connection.json"),
            r#"{"socketPath":"/tmp/s","httpPort":4123,"token":"tok","pid":1,"version":"0.1.0"}"#,
        )
        .unwrap();
        let c = read_connection(&dir).unwrap();
        assert_eq!((c.http_port, c.token.as_str()), (4123, "tok"));
        assert_eq!(c.base(), "http://127.0.0.1:4123");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
