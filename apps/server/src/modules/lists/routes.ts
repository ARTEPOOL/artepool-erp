import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreatePaymentMethodRequest,
  CreateReasonCodeRequest,
  CreateLabelSizeRequest,
  CreateTechnicianRequest,
  CreateWarehouseRequest,
  IdText,
  ReactivateRequest,
  UpdatePaymentMethodRequest,
  UpdateReasonCodeRequest,
  UpdateLabelSizeRequest,
  UpdateTechnicianRequest,
  UpdateWarehouseRequest,
} from '@artepool/shared/contracts';
import { defineActivation, defineRoute, defineWrite } from '../../platform/http/route';
import * as lists from './service';

const Params = z.object({ id: IdText });

export function registerListRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // Barcode label sizes (decision 0043): everyone signed in reads them; the owner manages them
  const labelSizes = { kind: 'permission', permission: 'system.settings.edit' } as const;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/label-sizes',
    access: { kind: 'session' },
    handler: async () => ({ labelSizes: await lists.listLabelSizes(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/label-sizes',
    access: labelSizes,
    body: CreateLabelSizeRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await lists.createLabelSize(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/label-sizes/:id',
    access: labelSizes,
    params: Params,
    body: UpdateLabelSizeRequest,
    handler: async ({ trx, params, body }) => ({
      body: await lists.updateLabelSize(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/label-sizes',
    access: labelSizes,
    setActive: lists.setLabelSizeActive,
  });

  // Technicians
  const technicians = { kind: 'permission', permission: 'technicians.manage' } as const;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/technicians',
    access: technicians,
    handler: async () => ({ technicians: await lists.listTechnicians(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/technicians',
    access: technicians,
    body: CreateTechnicianRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await lists.createTechnician(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/technicians/:id',
    access: technicians,
    params: Params,
    body: UpdateTechnicianRequest,
    handler: async ({ trx, params, body }) => ({
      body: await lists.updateTechnician(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/technicians',
    access: technicians,
    setActive: lists.setTechnicianActive,
  });

  // Payment methods
  const payments = { kind: 'permission', permission: 'payment_methods.manage' } as const;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/payment-methods',
    access: payments,
    handler: async () => ({ paymentMethods: await lists.listPaymentMethods(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/payment-methods',
    access: payments,
    body: CreatePaymentMethodRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await lists.createPaymentMethod(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/payment-methods/:id',
    access: payments,
    params: Params,
    body: UpdatePaymentMethodRequest,
    handler: async ({ trx, params, body }) => ({
      body: await lists.updatePaymentMethod(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/payment-methods',
    access: payments,
    setActive: lists.setPaymentMethodActive,
  });

  // Warehouses
  const warehouses = { kind: 'permission', permission: 'warehouses.manage' } as const;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/warehouses',
    access: warehouses,
    handler: async () => ({ warehouses: await lists.listWarehouses(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/warehouses',
    access: warehouses,
    body: CreateWarehouseRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await lists.createWarehouse(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/warehouses/:id',
    access: warehouses,
    params: Params,
    body: UpdateWarehouseRequest,
    handler: async ({ trx, params, body }) => ({
      body: await lists.updateWarehouse(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/warehouses/:id/make-default',
    access: warehouses,
    params: Params,
    body: ReactivateRequest,
    handler: async ({ trx, params, body }) => ({
      body: {
        warehouses: await lists.makeDefaultWarehouse(trx, BigInt(params.id), body.rowVersion),
      },
    }),
  });
  defineActivation(app, {
    base: '/api/v1/warehouses',
    access: warehouses,
    setActive: lists.setWarehouseActive,
  });

  // Reason codes (owner: they post money to accounts, posting map rows 16–17)
  const reasons = { kind: 'permission', permission: 'system.settings.edit' } as const;
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/reason-codes',
    access: { kind: 'session' },
    handler: async () => ({ reasonCodes: await lists.listReasonCodes(db) }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/reason-codes',
    access: reasons,
    body: CreateReasonCodeRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await lists.createReasonCode(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PATCH',
    url: '/api/v1/reason-codes/:id',
    access: reasons,
    params: Params,
    body: UpdateReasonCodeRequest,
    handler: async ({ trx, params, body }) => ({
      body: await lists.updateReasonCode(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/reason-codes',
    access: reasons,
    setActive: lists.setReasonCodeActive,
  });
}
