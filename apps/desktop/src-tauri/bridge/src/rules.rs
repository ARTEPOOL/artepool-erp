//! What the screens may ask for. The screens are the less trusted side: everything they send is
//! checked here again (the same rules as `packages/shared/src/contracts/bridge.ts`).

/// The default API port on the Main Server (architecture §2).
pub const DEFAULT_SERVER_PORT: u16 = 3100;

/// What a person typed as the server address → `https://host:port`, or `None`.
pub fn server_url_from(address: &str) -> Option<String> {
    let text = address.trim();
    if text.is_empty() || text.chars().any(char::is_whitespace) || text.len() > 200 {
        return None;
    }
    let has_scheme = text.split_once("://").is_some_and(|(scheme, _)| {
        let mut chars = scheme.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    let with_scheme = if has_scheme {
        text.to_string()
    } else {
        format!("https://{text}")
    };
    let url = url::Url::parse(&with_scheme).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path() == "/" || url.path().is_empty())
    {
        return None;
    }
    let host = url.host_str().filter(|h| !h.is_empty())?;
    let port = url.port().unwrap_or(DEFAULT_SERVER_PORT);
    Some(format!("https://{host}:{port}"))
}

/// Only API paths (and the health check): the bridge is not a general proxy.
pub fn is_allowed_path(path: &str) -> bool {
    if path.len() > 512 {
        return false;
    }
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (path, None),
    };
    let route_ok = route == "/health"
        || route.strip_prefix("/api/v1/").is_some_and(|rest| {
            rest.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '/' | '%')
            })
        });
    let query_ok = query.is_none_or(|q| {
        q.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '%' | '&' | '=' | '+')
        })
    });
    route_ok && query_ok && !route.split('/').any(|segment| segment == "..")
}

/// A session token: base64url, at most 128 characters.
pub fn is_token(token: &str) -> bool {
    (1..=128).contains(&token.len())
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// An idempotency key: a UUID in its usual text form.
pub fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.chars().all(|c| c.is_ascii_hexdigit()))
}

/// The Windows computer name, e.g. `COUNTER-01`: `[A-Za-z0-9][A-Za-z0-9._-]{0,31}`.
pub fn is_device_code(code: &str) -> bool {
    let mut chars = code.chars();
    (1..=32).contains(&code.len())
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The computer name made into a valid device code (the same rule as the development bridge).
pub fn suggested_code(computer_name: &str) -> String {
    let upper: String = computer_name
        .to_uppercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed: String = upper
        .trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
        .chars()
        .take(32)
        .collect();
    if trimmed.is_empty() {
        "PC-01".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_become_https_with_the_default_port() {
        assert_eq!(
            server_url_from("artepool-server").as_deref(),
            Some("https://artepool-server:3100")
        );
        assert_eq!(
            server_url_from(" 192.168.1.10 ").as_deref(),
            Some("https://192.168.1.10:3100")
        );
        assert_eq!(
            server_url_from("192.168.1.10:4000").as_deref(),
            Some("https://192.168.1.10:4000")
        );
        assert_eq!(
            server_url_from("https://artepool-server:3100/").as_deref(),
            Some("https://artepool-server:3100")
        );
        assert_eq!(
            server_url_from("[::1]:3100").as_deref(),
            Some("https://[::1]:3100")
        );
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "http://artepool-server",
            "ftp://x",
            "https://user:pass@server",
            "https://server/path",
            "https://server?x=1",
            "two words",
        ] {
            assert_eq!(server_url_from(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_api_paths_can_be_requested() {
        assert!(is_allowed_path("/api/v1/auth/me"));
        assert!(is_allowed_path("/api/v1/audit?limit=50&kind=security"));
        assert!(is_allowed_path("/health"));
        for bad in [
            "https://evil.example/api/v1/x",
            "//evil.example/api/v1",
            "/api/v1/../../etc",
            "/admin",
            "/api/v2/x",
            "/api/v1/a b",
            "/api/v1/x\r\nhost: evil",
        ] {
            assert!(!is_allowed_path(bad), "{bad}");
        }
    }

    #[test]
    fn tokens_keys_and_codes_must_be_well_formed() {
        assert!(is_token("abc_DEF-123"));
        assert!(!is_token("a\r\nx-evil: 1"));
        assert!(!is_token(""));
        assert!(is_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(is_device_code("COUNTER-01"));
        assert!(!is_device_code("-COUNTER"));
        assert!(!is_device_code("NAME WITH SPACE"));
    }

    #[test]
    fn suggests_the_computer_name() {
        assert_eq!(suggested_code("counter-01"), "COUNTER-01");
        assert_eq!(suggested_code("Ahmed’s PC"), "AHMED-S-PC");
        assert_eq!(suggested_code("---"), "PC-01");
        assert_eq!(suggested_code(&"x".repeat(40)).len(), 32);
    }
}
