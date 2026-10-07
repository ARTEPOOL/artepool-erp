//! The connection rules (architecture §6): TLS 1.3 only, only the pinned ARTÉPOOL CA, the
//! server's name checked, and the CA's name constraints respected.

mod support;

use artepool_bridge::connection::{self, ConnectionError, Request};
use artepool_bridge::tls;
use support::{Ca, ok_handler, serve};

async fn get(url: &str, config: rustls::ClientConfig) -> Result<u16, ConnectionError> {
    let client = connection::client(config)?;
    let request = Request {
        method: "GET",
        url: url::Url::parse(&format!("{url}/health")).unwrap(),
        headers: vec![],
        body: None,
    };
    connection::send(&client, request).await.map(|a| a.status)
}

#[tokio::test]
async fn talks_tls_1_3_to_a_server_from_the_pinned_ca() {
    let ca = Ca::new(&["localhost", "127.0.0.1"]);
    let (chain, key) = ca.issue(&["localhost"]);
    let server = serve(chain, key, false, ok_handler()).await;
    assert_eq!(
        get(&server.url(), tls::pinned_config(&ca.pem).unwrap())
            .await
            .unwrap(),
        200
    );
}

#[tokio::test]
async fn refuses_a_server_from_another_ca() {
    let (ours, theirs) = (Ca::new(&[]), Ca::new(&[]));
    let (chain, key) = theirs.issue(&["localhost"]);
    let server = serve(chain, key, false, ok_handler()).await;
    let result = get(&server.url(), tls::pinned_config(&ours.pem).unwrap()).await;
    assert!(
        matches!(result, Err(ConnectionError::Untrusted(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn refuses_tls_1_2() {
    let ca = Ca::new(&[]);
    let (chain, key) = ca.issue(&["localhost"]);
    let server = serve(chain, key, true, ok_handler()).await;
    let result = get(&server.url(), tls::pinned_config(&ca.pem).unwrap()).await;
    assert!(
        matches!(result, Err(ConnectionError::Untrusted(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn refuses_a_certificate_for_another_name() {
    let ca = Ca::new(&[]);
    let (chain, key) = ca.issue(&["other.example"]);
    let server = serve(chain, key, false, ok_handler()).await;
    let result = get(&server.url(), tls::pinned_config(&ca.pem).unwrap()).await;
    assert!(
        matches!(result, Err(ConnectionError::Untrusted(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn the_ca_cannot_vouch_outside_its_name_constraints() {
    // Even with the CA key, a certificate for a name the CA was not created for is refused.
    let ca = Ca::new(&["artepool-server"]);
    let (chain, key) = ca.issue(&["localhost"]);
    let server = serve(chain, key, false, ok_handler()).await;
    let result = get(&server.url(), tls::pinned_config(&ca.pem).unwrap()).await;
    assert!(
        matches!(result, Err(ConnectionError::Untrusted(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn reports_an_address_where_nothing_answers_as_unreachable() {
    let ca = Ca::new(&[]);
    let result = get("https://127.0.0.1:1", tls::pinned_config(&ca.pem).unwrap()).await;
    assert!(
        matches!(result, Err(ConnectionError::Unreachable(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn the_enrollment_hello_records_the_certificate_for_checking_afterwards() {
    let (ca, other) = (Ca::new(&["localhost"]), Ca::new(&[]));
    let (chain, key) = ca.issue(&["localhost"]);
    let server = serve(chain, key, false, ok_handler()).await;
    let (config, captured) = tls::capturing_config();
    assert_eq!(get(&server.url(), config).await.unwrap(), 200);
    let cert = captured
        .lock()
        .unwrap()
        .clone()
        .expect("the certificate was recorded");
    assert!(tls::issued_for(&cert, &ca.pem, "localhost"));
    assert!(!tls::issued_for(&cert, &ca.pem, "artepool-server"));
    assert!(!tls::issued_for(&cert, &other.pem, "localhost"));
}
