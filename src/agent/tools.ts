/**
 * Compatibility shim. The tool surface now lives in `./tools/`: one module per feature area for the
 * definitions, plus `./tools/index.ts` for `buildTools()` and the single `runTool()` dispatch.
 *
 * It stayed as a file rather than becoming a rename because NodeNext does not resolve directory
 * indexes — every existing `from './tools.js'` would have had to become `from './tools/index.js'`,
 * and rewriting those imports across in-flight feature branches is exactly the merge pain this
 * split exists to avoid. Import either path; they are the same module graph.
 */
export { buildTools, runTool } from './tools/index.js'
