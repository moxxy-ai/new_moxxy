import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Directory holding the workflows shipped with this package (the sample
 * `stock-market-digest.yaml`). Passed to the `WorkflowStore` as its
 * `builtinDir`. When the CLI is bundled and this path doesn't exist at
 * runtime, `discoverWorkflows` simply finds nothing there — no crash.
 */
export const BUILTIN_WORKFLOWS_DIR: string = path.resolve(__dirname, '../workflows');
