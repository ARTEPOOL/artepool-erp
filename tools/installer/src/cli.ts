/** `pnpm build:installer` — see build.ts. */
import { buildInstaller } from './build';

try {
  const file = await buildInstaller();
  console.log(`Server installer: ${file}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
