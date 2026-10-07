//! One HTTPS request to the Main Server with a given TLS configuration.

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rustls::ClientConfig;
use std::time::Duration;

pub struct Answer {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    /// No answer: off, unplugged, wrong address, or too slow.
    #[error("unreachable: {0}")]
    Unreachable(String),
    /// Something answered that is not the ARTÉPOOL server (TLS refused).
    #[error("untrusted: {0}")]
    Untrusted(String),
}

pub struct Request<'a> {
    pub method: &'a str,
    pub url: url::Url,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<Vec<u8>>,
}

/// Is there a TLS error anywhere inside? (I/O errors wrap it, sometimes twice.)
fn has_tls_error(error: &(dyn std::error::Error + 'static)) -> bool {
    if error.downcast_ref::<rustls::Error>().is_some() {
        return true;
    }
    if let Some(io) = error.downcast_ref::<std::io::Error>()
        && let Some(inner) = io.get_ref()
        && has_tls_error(inner)
    {
        return true;
    }
    error.source().is_some_and(has_tls_error)
}

/// TLS problems mean the other side is not our server; anything else means no answer.
fn classify(error: reqwest::Error) -> ConnectionError {
    if has_tls_error(&error) {
        ConnectionError::Untrusted(error.to_string())
    } else {
        ConnectionError::Unreachable(error.to_string())
    }
}

pub fn client(tls: ClientConfig) -> Result<reqwest::Client, ConnectionError> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(tls)
        .https_only(true)
        .no_proxy()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ConnectionError::Unreachable(e.to_string()))
}

pub async fn send(
    client: &reqwest::Client,
    request: Request<'_>,
) -> Result<Answer, ConnectionError> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| ConnectionError::Unreachable(e.to_string()))?;
    let mut headers = HeaderMap::new();
    for (name, value) in request.headers {
        let value = HeaderValue::from_str(&value)
            .map_err(|e| ConnectionError::Unreachable(e.to_string()))?;
        headers.insert(HeaderName::from_static(name), value);
    }
    let mut builder = client.request(method, request.url).headers(headers);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let response = builder.send().await.map_err(classify)?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = response.bytes().await.map_err(classify)?.to_vec();
    Ok(Answer {
        status,
        content_type,
        body,
    })
}
