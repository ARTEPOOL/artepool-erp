import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCustomerRequest,
  CreateSupplierRequest,
  CustomersQuery,
  IdText,
  ListQuery,
  SetCustomerCreditRequest,
  UpdateCustomerRequest,
  UpdateSupplierRequest,
} from '@artepool/shared/contracts';
import { recordEvent } from '../../platform/audit/events';
import { withBusinessTx } from '../../platform/db/tx';
import { contextOf } from '../../platform/http/context';
import { defineActivation, defineRoute, defineWrite } from '../../platform/http/route';
import { exportCustomers } from '../imports/service';
import * as customers from './customers';
import * as suppliers from './suppliers';

const Params = z.object({ id: IdText });
const viewCustomers = { kind: 'permission', permission: 'customers.view' } as const;
const manageCustomers = { kind: 'permission', permission: 'customers.manage' } as const;
const manageSuppliers = { kind: 'permission', permission: 'suppliers.manage' } as const;

export function registerPartyRoutes(app: FastifyInstance): void {
  const db = app.deps.db;

  // Customers (design 14)
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers',
    access: viewCustomers,
    query: CustomersQuery,
    handler: ({ query }) => customers.listCustomers(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers/export',
    access: { kind: 'permission', permission: 'data.export' },
    handler: async ({ request }) => {
      const { file, rows } = await exportCustomers(db);
      // Exports are permission-controlled and logged (PRD security requirements).
      await withBusinessTx(db, contextOf(request), (trx) =>
        recordEvent(trx, 'data.exported', { data: { entity: 'customers', rows } }),
      );
      return file;
    },
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/customers/:id',
    access: viewCustomers,
    params: Params,
    handler: ({ params }) => customers.getCustomer(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/customers',
    access: manageCustomers,
    body: CreateCustomerRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await customers.createCustomer(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/customers/:id',
    access: manageCustomers,
    params: Params,
    body: UpdateCustomerRequest,
    handler: async ({ trx, params, body }) => ({
      body: await customers.updateCustomer(trx, BigInt(params.id), body),
    }),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/customers/:id/credit',
    access: { kind: 'permission', permission: 'customers.credit' },
    params: Params,
    body: SetCustomerCreditRequest,
    reason: ({ body }) => body.reason,
    handler: async ({ trx, params, body }) => ({
      body: await customers.setCustomerCredit(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/customers',
    access: manageCustomers,
    setActive: customers.setCustomerActive,
  });

  // Suppliers
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/suppliers',
    access: manageSuppliers,
    query: ListQuery,
    handler: ({ query }) => suppliers.listSuppliers(db, query),
  });
  defineRoute(app, {
    method: 'GET',
    url: '/api/v1/suppliers/:id',
    access: manageSuppliers,
    params: Params,
    handler: ({ params }) => suppliers.getSupplier(db, BigInt(params.id)),
  });
  defineWrite(app, {
    method: 'POST',
    url: '/api/v1/suppliers',
    access: manageSuppliers,
    body: CreateSupplierRequest,
    handler: async ({ trx, body }) => ({
      status: 201,
      body: await suppliers.createSupplier(trx, body),
    }),
  });
  defineWrite(app, {
    method: 'PUT',
    url: '/api/v1/suppliers/:id',
    access: manageSuppliers,
    params: Params,
    body: UpdateSupplierRequest,
    handler: async ({ trx, params, body }) => ({
      body: await suppliers.updateSupplier(trx, BigInt(params.id), body),
    }),
  });
  defineActivation(app, {
    base: '/api/v1/suppliers',
    access: manageSuppliers,
    setActive: suppliers.setSupplierActive,
  });
}
