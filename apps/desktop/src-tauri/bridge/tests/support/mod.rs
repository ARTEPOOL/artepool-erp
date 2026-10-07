//! A small HTTPS server for the tests: its own CA (optionally name-constrained), a certificate
//! for the names asked for, and a request handler.
#![allow(dead_code)]

use rcgen::{
    BasicConstraints, CertificateParams, CidrSubnet, GeneralSubtree, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, NameConstraints,
};
use rustls::ServerConfig;
use rustls::version::{TLS12, TLS13};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

pub struct Ca {
    pub pem: String,
    issuer: Issuer<'static, KeyPair>,
}

impl Ca {
    /// A CA that may vouch only for `permitted` names (empty = no constraint).
    pub fn new(permitted: &[&str]) -> Self {
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        if !permitted.is_empty() {
            params.name_constraints = Some(NameConstraints {
                permitted_subtrees: permitted
                    .iter()
                    .map(|name| match name.parse::<IpAddr>() {
                        Ok(IpAddr::V4(ip)) => {
                            GeneralSubtree::IpAddress(CidrSubnet::V4(ip.octets(), [255; 4]))
                        }
                        Ok(IpAddr::V6(ip)) => {
                            GeneralSubtree::IpAddress(CidrSubnet::V6(ip.octets(), [255; 16]))
                        }
                        Err(_) => GeneralSubtree::DnsName((*name).to_string()),
                    })
                    .collect(),
                excluded_subtrees: vec![],
            });
        }
        let key = KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        Self {
            pem: cert.pem(),
            issuer: Issuer::new(params, key),
        }
    }

    pub fn issue(&self, names: &[&str]) -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let params =
            CertificateParams::new(names.iter().map(|n| (*n).to_string()).collect::<Vec<_>>())
                .unwrap();
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &self.issuer).unwrap();
        (
            vec![cert.der().clone()],
            PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
    }
}

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

pub struct HttpResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

pub type Handler = Arc<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>;

pub struct Server {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
    /// Open connections, closed when the server stops (like a server PC switched off).
    connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>>,
}

impl Server {
    pub fn url(&self) -> String {
        format!("https://localhost:{}", self.port)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
        for connection in self.connections.lock().unwrap().drain(..) {
            connection.abort();
        }
    }
}

async fn read_request<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> Option<HttpRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
        if let Some(i) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let path = first.next()?.to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

/// Serves HTTPS on 127.0.0.1 with the given certificate; `tls12_only` for the refusal test.
pub async fn serve(
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    tls12_only: bool,
    handler: Handler,
) -> Server {
    let versions: &[&rustls::SupportedProtocolVersion] =
        if tls12_only { &[&TLS12] } else { &[&TLS13] };
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(versions)
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections: Arc<std::sync::Mutex<Vec<tokio::task::AbortHandle>>> = Arc::default();
    let tracked = Arc::clone(&connections);
    let task = tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            let acceptor = acceptor.clone();
            let handler = Arc::clone(&handler);
            let connection = tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                while let Some(request) = read_request(&mut tls).await {
                    let response = handler(&request);
                    let body = response.body.to_string();
                    let text = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: {}\r\n\r\n{}",
                        response.status,
                        body.len(),
                        body
                    );
                    if tls.write_all(text.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
            tracked.lock().unwrap().push(connection.abort_handle());
        }
    });
    Server {
        port,
        task,
        connections,
    }
}

/// A handler that always answers 200 with `{"ok":true}`.
pub fn ok_handler() -> Handler {
    Arc::new(|_| HttpResponse {
        status: 200,
        body: serde_json::json!({ "ok": true }),
    })
}
