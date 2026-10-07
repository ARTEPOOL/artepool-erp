//! TLS for the Main Server (architecture §6): TLS 1.3 only, trusting only the pinned ARTÉPOOL CA,
//! with the server's name checked (and the CA's name constraints, by webpki).

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls13_signature};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::pem::PemObject as _;
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use std::sync::{Arc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("the ARTÉPOOL certificate is not valid: {0}")]
    BadCa(String),
}

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn roots(ca_pem: &str) -> Result<RootCertStore, TlsError> {
    let ca = CertificateDer::from_pem_slice(ca_pem.as_bytes())
        .map_err(|e| TlsError::BadCa(e.to_string()))?;
    let mut roots = RootCertStore::empty();
    roots.add(ca).map_err(|e| TlsError::BadCa(e.to_string()))?;
    Ok(roots)
}

/// After enrollment: TLS 1.3, only the ARTÉPOOL CA, the server's name checked.
pub fn pinned_config(ca_pem: &str) -> Result<ClientConfig, TlsError> {
    Ok(ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("the ring provider supports TLS 1.3")
        .with_root_certificates(roots(ca_pem)?)
        .with_no_client_auth())
}

/// The certificate a server presented during the enrollment hello.
pub type Captured = Arc<Mutex<Option<CertificateDer<'static>>>>;

/// For the enrollment hello only, before the PC knows the CA: the connection is still TLS 1.3
/// and the server must prove it holds its certificate's key, but the certificate is only
/// recorded here. It is accepted afterwards only if the code's proof shows the CA is genuine
/// and that CA issued this certificate for this name (`issued_for`).
pub fn capturing_config() -> (ClientConfig, Captured) {
    let captured: Captured = Arc::default();
    let verifier = CaptureVerifier {
        provider: provider(),
        captured: Arc::clone(&captured),
    };
    let config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("the ring provider supports TLS 1.3")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    (config, captured)
}

#[derive(Debug)]
struct CaptureVerifier {
    provider: Arc<CryptoProvider>,
    captured: Captured,
}

impl ServerCertVerifier for CaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.captured.lock().expect("capture lock") = Some(end_entity.clone().into_owned());
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        // Never reached: only TLS 1.3 is offered.
        Err(rustls::Error::General("TLS 1.2 is not used".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Did `ca_pem` issue `certificate` for `host` (chain, dates, name, name constraints)?
pub fn issued_for(certificate: &CertificateDer<'_>, ca_pem: &str, host: &str) -> bool {
    let Ok(roots) = roots(ca_pem) else {
        return false;
    };
    let Ok(verifier) =
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider()).build()
    else {
        return false;
    };
    let Ok(name) = ServerName::try_from(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_string(),
    ) else {
        return false;
    };
    verifier
        .verify_server_cert(certificate, &[], &name, &[], UnixTime::now())
        .is_ok()
}
