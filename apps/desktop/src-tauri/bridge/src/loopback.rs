//! Google sign-in for the backup account (decision 0095): Google sends its one-time code back to
//! a short-lived address on this PC (`http://127.0.0.1:<port>/callback`). This listener accepts
//! that one answer, shows a short "done" page, and closes. Only this PC can reach it, it gives
//! up after a few minutes, and the code is useless without the server's PKCE verifier.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Callback {
    pub code: String,
    pub state: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LoopbackError {
    #[error("Google sign-in was cancelled ({0})")]
    Refused(String),
    #[error("Google sign-in did not finish in time")]
    TimedOut,
    #[error("Google sign-in answer not understood")]
    Malformed,
    #[error("local listener: {0}")]
    Io(String),
}

const DONE_PAGE: &str = "<!doctype html><html lang=\"ar\" dir=\"rtl\"><meta charset=\"utf-8\">\
<title>ARTEPOOL</title><body style=\"font-family:sans-serif;text-align:center;padding:3rem\">\
<h1>تم — ارجع لبرنامج آرتيبول</h1><p dir=\"ltr\">Done — return to ARTEPOOL ERP.</p></body></html>";

/// What Google's redirect asks for: `GET /callback?code=…&state=…` (or `?error=…`).
pub fn parse_callback(request_line: &str) -> Result<Option<Callback>, LoopbackError> {
    let mut parts = request_line.split(' ');
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else {
        return Err(LoopbackError::Malformed);
    };
    let url = url::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| LoopbackError::Malformed)?;
    if url.path() != "/callback" {
        return Ok(None); // the browser asking for something else, e.g. /favicon.ico
    }
    let get = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    if let Some(error) = get("error") {
        return Err(LoopbackError::Refused(error.chars().take(64).collect()));
    }
    match (get("code"), get("state")) {
        (Some(code), Some(state))
            if (4..=1000).contains(&code.len()) && (16..=200).contains(&state.len()) =>
        {
            Ok(Some(Callback { code, state }))
        }
        _ => Err(LoopbackError::Malformed),
    }
}

pub struct Loopback {
    listener: TcpListener,
}

impl Loopback {
    /// Opens the listener on a free port of 127.0.0.1 (this PC only).
    pub fn bind() -> Result<Self, LoopbackError> {
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|e| LoopbackError::Io(e.to_string()))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// Waits for Google's answer, at most `timeout`. Other requests get "not found".
    pub fn wait(self, timeout: Duration) -> Result<Callback, LoopbackError> {
        let deadline = Instant::now() + timeout;
        self.listener
            .set_nonblocking(true)
            .map_err(|e| LoopbackError::Io(e.to_string()))?;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(answer) = answer(stream)? {
                        return Ok(answer);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(LoopbackError::TimedOut);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(LoopbackError::Io(e.to_string())),
            }
        }
    }
}

fn answer(mut stream: TcpStream) -> Result<Option<Callback>, LoopbackError> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    while head.len() < 8192 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let text = String::from_utf8_lossy(&head);
    let line = text.lines().next().unwrap_or_default();
    let result = parse_callback(line);
    let (status, body) = match &result {
        Ok(None) => ("404 Not Found", ""),
        _ => ("200 OK", DONE_PAGE),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\
         cache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    result
}

/// Only Google's own sign-in page may be opened from here.
pub fn is_google_sign_in(url: &str) -> bool {
    url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?")
        && !url.contains(char::is_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_code_and_state_and_ignores_other_paths() {
        let state = "s".repeat(32);
        assert_eq!(
            parse_callback(&format!(
                "GET /callback?state={state}&code=4%2F0Ab-x HTTP/1.1"
            )),
            Ok(Some(Callback {
                code: "4/0Ab-x".into(),
                state: state.clone()
            }))
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), Ok(None));
        assert_eq!(
            parse_callback("GET /callback?error=access_denied HTTP/1.1"),
            Err(LoopbackError::Refused("access_denied".into()))
        );
        assert_eq!(
            parse_callback("GET /callback?code=abcd HTTP/1.1"),
            Err(LoopbackError::Malformed)
        );
        assert_eq!(
            parse_callback("POST /callback HTTP/1.1"),
            Err(LoopbackError::Malformed)
        );
    }

    #[test]
    fn receives_one_answer_on_this_pc_only_and_gives_up_in_time() {
        let loopback = Loopback::bind().unwrap();
        let port = loopback.port();
        let state = "t".repeat(24);
        let waiter = std::thread::spawn(move || loopback.wait(Duration::from_secs(5)));
        // The browser first asks for the icon, then follows Google's redirect.
        for path in [
            "/favicon.ico".to_string(),
            format!("/callback?code=abcd1234&state={state}"),
        ] {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
            let mut reply = String::new();
            let _ = s.read_to_string(&mut reply);
        }
        assert_eq!(
            waiter.join().unwrap(),
            Ok(Callback {
                code: "abcd1234".into(),
                state
            })
        );
        assert_eq!(
            Loopback::bind().unwrap().wait(Duration::from_millis(200)),
            Err(LoopbackError::TimedOut)
        );
    }

    #[test]
    fn opens_only_google_sign_in_pages() {
        assert!(is_google_sign_in(
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x"
        ));
        assert!(!is_google_sign_in(
            "https://evil.example/o/oauth2/v2/auth?x"
        ));
        assert!(!is_google_sign_in(
            "https://accounts.google.com.evil.example/o/oauth2/v2/auth?x"
        ));
        assert!(!is_google_sign_in("file:///C:/Windows/System32/calc.exe"));
    }
}
