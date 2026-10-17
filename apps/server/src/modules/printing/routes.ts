import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DESIGNED_KINDS,
  PreviewTemplateRequest,
  SaveReceiptLogoRequest,
  SaveTemplateRequest,
  type FilePayload,
  type PreviewTemplateResponse,
  type PrintTemplatesResponse,
} from '@artepool/shared/contracts';
import { AppError } from '../../platform/errors/app-error';
import { defineRoute, defineWrite } from '../../platform/http/route';
import * as designer from './designer';
import { renderPdf } from './render';

/** Owner only (decision 0020): `print_templates.manage`, checked again by the database. */
const manage = { kind: 'permission', permission: 'print_templates.manage' } as const;
const KindParams = z.object({ kind: z.enum(DESIGNED_KINDS) });

export function registerPrintingRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

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
