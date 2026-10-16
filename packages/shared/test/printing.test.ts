import { describe, expect, it } from 'vitest';
import {
  DESIGNED_KINDS,
  FIELDS_BY_KIND,
  LOCKED_BY_KIND,
  TemplateSettings,
  defaultTemplateSettings,
  readTemplateSettings,
  shows,
} from '../src/contracts/printing';

describe('print templates (decision 0064)', () => {
  it('reads the first versions (migration 0016) with their old names', () => {
    const s = readTemplateSettings('tax_invoice_a4', {
      language: 'ar',
      showLogo: false,
      logoPosition: 'start',
      logoSizeMm: 30,
      textSize: 'large',
      marginsMm: { top: 12, bottom: 12, start: 12, end: 12 },
      optional: { lineDiscount: false, bankDetails: false },
      texts: { footerAr: 'شكرًا', footerEn: 'Thanks' },
    });
    expect(s).toMatchObject({
      language: 'ar',
      logoPosition: 'beside',
      logoSizeMm: 30,
      textSize: 'large',
      margins: 'normal',
      bankAccountId: null,
    });
    expect(s.fields.logo).toBe(false);
    expect(s.fields.lineDiscount).toBe(false);
    expect(s.texts.footerAr).toBe('شكرًا');
    expect(TemplateSettings.safeParse(s).success).toBe(true);
  });

  it('falls back to the default for anything unreadable', () => {
    expect(readTemplateSettings('quotation_a4', { language: 'fr' })).toEqual(
      defaultTemplateSettings('quotation_a4'),
    );
    expect(readTemplateSettings('quotation_a4', null)).toEqual(
      defaultTemplateSettings('quotation_a4'),
    );
  });

  it('the seller’s address and TRN are optional on the quotation only; locked on tax documents', () => {
    for (const kind of DESIGNED_KINDS) {
      const optional = FIELDS_BY_KIND[kind].includes('sellerAddress');
      expect(optional).toBe(kind === 'quotation_a4');
      expect(LOCKED_BY_KIND[kind].includes('sellerAddressTrn')).toBe(kind !== 'quotation_a4');
    }
    const off = { ...defaultTemplateSettings('tax_invoice_a4') };
    off.fields = { ...off.fields, sellerAddress: false };
    expect(shows('tax_invoice_a4', off, 'sellerAddress')).toBe(false);
    expect(LOCKED_BY_KIND.credit_note_a4).toContain('originalInvoice');
    expect(LOCKED_BY_KIND.credit_note_a4).toContain('reason');
    expect(LOCKED_BY_KIND.tax_invoice_a4).toContain('customerFull');
  });
});
