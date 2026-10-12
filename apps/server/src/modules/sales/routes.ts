/**
 * Sales routes (M4): Invoices (A4), Quotations and Receipts are separate sections (decision 0045).
 * Each route names the permission it needs; actions that also need a second one check it in
 * the handler (payments at issue, refunds, credit notes, debit notes).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateNoteRequest,
  DiscardRequest,
  DocumentsQuery,
  IdText,
  IssueRequest,
  OpeningBalanceRequest,
  PaymentsQuery,
  QuotationActionRequest,
  QuotationsQuery,
  ReceivePaymentRequest,
  ReversePaymentRequest,
  RowVersion,
  SaveInvoiceRequest,
  SaveQuotationRequest,
  StatementQuery,
} from '@artepool/shared/contracts';
import { defineRoute, defineWrite } from '../../platform/http/route';
import { requireAlso } from '../../platform/permissions';
import * as documents from './documents';
import { createNote, creditWholeAdvance } from './notes';
import * as payments from './payments';
import * as quotations from './quotations';
import * as statements from './statement';

const Params = z.object({ id: IdText });
const allow = (permission: string) => ({ kind: 'permission', permission }) as const;

export function registerSalesRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // ---------------------------------------------------------------- Invoices (A4) and notes
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/documents',
    access: allow('invoices.view'),
    query: DocumentsQuery,
    handler: ({ query }) => documents.listDocuments(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/documents/:id',
    access: allow('invoices.view'),
    params: Params,
    handler: ({ params }) => documents.getDocument(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/invoices',
    access: allow('invoices.create'),
    body: SaveInvoiceRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await documents.getDocument(trx, await documents.saveInvoiceDraft(trx, null, body)),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/sales/invoices/:id',
    access: allow('invoices.create'),
    params: Params,
    body: SaveInvoiceRequest,
    handler: async ({ trx, params, body }) => ({
      body: await documents.getDocument(
        trx,
        await documents.saveInvoiceDraft(trx, BigInt(params.id), body),
      ),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/documents/:id/issue',
    access: allow('invoices.issue'),
    params: Params,
    body: IssueRequest,
    handler: async ({ trx, request, params, body }) => {
      if (body.payments && body.payments.length > 0) requireAlso(request.auth, 'payments.receive');
      const id = BigInt(params.id);
      await documents.issueInvoice(trx, id, body, async (documentId, customerId, parts) => {
        for (const part of parts) {
          await payments.receivePayment(trx, {
            customerId: customerId.toString(),
            part,
            allocations: [{ documentId: documentId.toString(), amountFils: part.amountFils }],
          });
        }
      });
      return { body: await documents.getDocument(trx, id) };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/documents/:id/discard',
    access: allow('invoices.create'),
    params: Params,
    body: DiscardRequest,
    handler: async ({ trx, params, body }) => {
      await documents.discardDocument(trx, BigInt(params.id), body.rowVersion);
      return { body: await documents.getDocument(trx, BigInt(params.id)) };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/notes',
    access: allow('invoices.create'),
    body: CreateNoteRequest,
    handler: async ({ trx, request, body }) => {
      if (body.kind === 'debit_note') requireAlso(request.auth, 'invoices.issue');
      if (body.refund && body.refund.length > 0) requireAlso(request.auth, 'payments.refund');
      return { status: 201, body: await createNote(trx, request.auth, body) };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/documents/:id/printed',
    access: allow('invoices.view'),
    params: Params,
    body: z.object({}),
    handler: async ({ trx, params }) => ({
      body: { printCount: await documents.countPrint(trx, BigInt(params.id)) },
    }),
  });

  // ---------------------------------------------------------------- Quotations
  const quote = allow('quotations.manage');
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/quotations',
    access: quote,
    query: QuotationsQuery,
    handler: ({ query }) => quotations.listQuotations(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/quotations/:id',
    access: quote,
    params: Params,
    handler: ({ params }) => quotations.getQuotation(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/quotations',
    access: quote,
    body: SaveQuotationRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await quotations.getQuotation(trx, await quotations.saveQuotation(trx, null, body)),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/sales/quotations/:id',
    access: quote,
    params: Params,
    body: SaveQuotationRequest,
    handler: async ({ trx, params, body }) => ({
      body: await quotations.getQuotation(
        trx,
        await quotations.saveQuotation(trx, BigInt(params.id), body),
      ),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/quotations/:id/revise',
    access: quote,
    params: Params,
    body: SaveQuotationRequest,
    handler: async ({ trx, params, body }) => ({
      status: 201,
      body: await quotations.getQuotation(
        trx,
        await quotations.saveQuotation(trx, BigInt(params.id), body, { revise: true }),
      ),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/quotations/:id/action',
    access: quote,
    params: Params,
    body: QuotationActionRequest.extend({ approvalId: IdText.optional() }),
    handler: async ({ trx, params, body }) => {
      await quotations.quotationAction(trx, BigInt(params.id), body);
      return { body: await quotations.getQuotation(trx, BigInt(params.id)) };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/quotations/:id/convert',
    access: quote,
    params: Params,
    body: z.object({ rowVersion: RowVersion }),
    handler: async ({ trx, request, params, body }) => {
      requireAlso(request.auth, 'invoices.create');
      const documentId = await quotations.convertQuotation(trx, BigInt(params.id), body.rowVersion);
      return { status: 201, body: await documents.getDocument(trx, documentId) };
    },
  });

  // ---------------------------------------------------------------- Receipts
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/payments',
    access: allow('invoices.view'),
    query: PaymentsQuery,
    handler: ({ query }) => payments.listPayments(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/sales/payments/:id',
    access: allow('invoices.view'),
    params: Params,
    handler: ({ params }) => payments.getPayment(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/payments',
    access: allow('payments.receive'),
    body: ReceivePaymentRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await payments.receivePayment(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/sales/payments/:id/reverse',
    access: allow('payments.reverse'),
    params: Params,
    body: ReversePaymentRequest,
    handler: async ({ trx, params, body }) => ({
      status: 201,
      body: await payments.reversePayment(trx, BigInt(params.id), body, (advanceId, reasonCodeId) =>
        creditWholeAdvance(trx, advanceId, reasonCodeId),
      ),
    }),
  });

  // ---------------------------------------------------------------- Customer accounts
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers/:id/balance',
    access: allow('customers.view'),
    params: Params,
    handler: ({ params }) => statements.customerBalance(db, BigInt(params.id)),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers/:id/statement',
    access: allow('customers.view'),
    params: Params,
    query: StatementQuery,
    handler: ({ params, query }) => statements.statement(db, BigInt(params.id), query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers/:id/opening-balance',
    access: allow('customers.view'),
    params: Params,
    handler: async ({ params }) => ({
      openingBalance: await statements.openingBalanceOf(db, BigInt(params.id)),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/customers/opening-balances',
    access: allow('customers.opening'),
    body: OpeningBalanceRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await statements.addOpeningBalance(trx, body),
    }),
  });
}
