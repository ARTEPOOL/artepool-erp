import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MigrationError } from './errors';

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Migrations must not manage transactions themselves: the runner wraps each file in one. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im;

/** Line endings are normalised so a Windows checkout produces the same checksum as Linux. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadMigrationFiles(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const fileName of readdirSync(dir).sort()) {
    if (!fileName.endsWith('.sql')) continue;
    const match = FILE_NAME.exec(fileName);
    if (!match) {
      throw new MigrationError(
        'BAD_FILE_NAME',
        `"${fileName}" is not a valid migration name (expected NNNN_lower_snake_name.sql).`,
      );
    }
    const sql = readFileSync(join(dir, fileName), 'utf8').replace(/\r\n/g, '\n');
    if (TRANSACTION_CONTROL.test(sql)) {
      throw new MigrationError(
        'FORBIDDEN_STATEMENT',
        `${fileName} contains BEGIN/COMMIT/ROLLBACK. The runner already runs each migration in one transaction.`,
      );
    }
    files.push({
      version: Number.parseInt(match[1] ?? '0', 10),
      name: match[2] ?? '',
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new MigrationError(
        'NUMBERING_GAP',
        `Migration numbers must be 0001, 0002, … without gaps or repeats; found ${file.fileName} at position ${index + 1}.`,
      );
    }
  });
  return files;
}
