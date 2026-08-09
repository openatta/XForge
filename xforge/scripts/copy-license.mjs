import { copyFile } from 'node:fs/promises';

await copyFile(new URL('../../LICENSE', import.meta.url), new URL('../dist/LICENSE', import.meta.url));
await copyFile(new URL('../../NOTICE', import.meta.url), new URL('../dist/NOTICE', import.meta.url));
