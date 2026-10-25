import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DESIGNED_KINDS,
  LabelItemsQuery,
  PriceChangedQuery,
  RecordLabelPrintsRequest,
  PreviewTemplateRequest,
  SaveLabelDesignRequest,
  SaveReceiptLogoRequest,
  SaveTemplateRequest,
  type FilePayload,
  type LabelDesignResponse,
  type PreviewTemplateResponse,
  type PrintTemplatesResponse,
} from '@artepool/shared/contracts';
import { AppError } from '../../platform/errors/app-error';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as designer from './designer';
import * as labels from './label-design';
import * as labelPrints from './label-prints';
import { renderPdf } from './render';

/** Owner only (decision 0020): `print_templates.manage`, checked again by the database. */
const manage = { kind: 'permission', permission: 'print_templates.manage' } as const;
const KindParams = z.object({ kind: z.enum(DESIGNED_KINDS) });
const printLabels = { kind: 'permission', permission: 'labels.print' } as const;

export function registerPrintingRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // The barcode label design (decision 0097): read by everyone who prints labels, saved by the owner.
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/label-design',
    access: { kind: 'session' },
    handler: async ({ request }): Promise<LabelDesignResponse> => {
      const { rows } = await sql<{ allowed: boolean }>`
        SELECT auth.user_has_permission(${request.auth!.userId}, 'print_templates.manage') AS allowed`.execute(
        db,
      );
      return labels.getLabelDesign(db, rows[0]?.allowed ?? false);
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/label-design/versions',
    access: manage,
    body: SaveLabelDesignRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await labels.saveLabelDesign(trx, body),
    }),
  });

  // Label prints (decision 0099): items for labels, the "price changed" list, the print record.
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/label-items',
    access: printLabels,
    query: LabelItemsQuery,
    handler: async ({ query }) => ({ items: await labelPrints.labelItems(db, query.ids) }),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/label-prints/price-changed',
    access: printLabels,
    query: PriceChangedQuery,
    handler: async ({ query }) => ({
      items: await labelPrints.priceChanged(db, query.categoryId),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/label-prints',
    access: printLabels,
    body: RecordLabelPrintsRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await labelPrints.recordLabelPrints(trx, body),
    }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/print-templates',
    access: { kind: 'session' },
    handler: async ({ request }): Promise<PrintTemplatesResponse> => {
      const { rows } = await sql<{ allowed: boolean }>`
        SELECT auth.user_has_permission(${request.auth!.userId}, 'print_templates.manage') AS allowed`.execute(
        db,
      );
      return designer.listTemplates(db, rows[0]?.allowed ?? false);
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/print-templates/:kind/versions',
    access: manage,
    params: KindParams,
    handler: async ({ params }) => ({ versions: await designer.listVersions(db, params.kind) }),
  });
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/print-templates/:kind/preview',
    access: manage,
    params: KindParams,
    body: PreviewTemplateRequest,
    handler: async ({ params, body }): Promise<PreviewTemplateResponse> => ({
      html: await designer.previewTemplate(db, params.kind, body.settings),
    }),
  });
  // "Test print": the sample document as a PDF, printed through the print dialog (A4 only).
  defineRoute(app, {
    method: 'POST',
    url: '/api/v1/print-templates/:kind/test-pdf',
    access: manage,
    params: KindParams,
    body: PreviewTemplateRequest,
    handler: async ({ params, body }): Promise<FilePayload> => {
      const html = await designer.previewTemplate(db, params.kind, body.settings);
      if (html === null) throw new AppError('NOT_FOUND', 'The receipt is printed by the PC');
      return {
        fileName: `${params.kind}-test.pdf`,
        mime: 'application/pdf',
        dataBase64: (await renderPdf(html)).toString('base64'),
      };
    },
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/print-templates/:kind/versions',
    access: manage,
    params: KindParams,
    body: SaveTemplateRequest,
    handler: async ({ trx, params, body }) => ({
      status: 201,
      body: await designer.saveTemplate(trx, params.kind, body),
    }),
  });
  // The thermal receipt's own logo (decision 0075): read by every PC that prints receipts.
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/print-templates/receipt-logo',
    access: { kind: 'session' },
    handler: () => designer.receiptLogo(db),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/print-templates/receipt-logo',
    access: manage,
    body: SaveReceiptLogoRequest,
    handler: async ({ trx, body }) => ({ body: await designer.saveReceiptLogo(trx, body) }),
  });
}
