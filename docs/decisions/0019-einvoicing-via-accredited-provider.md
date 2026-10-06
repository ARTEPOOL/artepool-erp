# 0019 — E-invoicing through an accredited service provider

| | |
|---|---|
| **Status** | Approach accepted; **go-live date pending accountant review** |
| **Date** | 2026-10-06 |
| **Decided by** | Owner |

## Decision
- **The ERP remains the system of record.**
- **E-invoicing is done by integrating with an accredited service provider (ASP) via its API.** The provider only transmits documents to the tax authority.
- **The outbox design stays in the Phase 1 database.**
- **ARTÉPOOL's e-invoicing go-live date is pending** from the accountant. It may move the integration earlier than P4.

## How it works
- **Ready from day one:** every issued tax document (invoice, payment invoice, credit note, debit note) gets a UUID and is stored in a structured form that can be converted to the required e-invoice format.
- **Phase 1 outbox:** the system writes an outbox entry for every issued tax document:
  - documents issued before the go-live date are marked `not_required`
  - documents issued after it are marked `pending`, ready to send
- **The go-live date is a setting** (`einvoice.mandatory_from`), empty until the accountant confirms it.
- **The integration** (sender, retries, provider responses) is built when the date and the provider are known.
- **Provider selection criteria:** a documented API, UAE accreditation, support for the required UAE e-invoice format, and tolerance of queued or offline sending.
