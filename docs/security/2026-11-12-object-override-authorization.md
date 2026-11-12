# Object-valued override permission guard

## Trigger and behavior

When API overrides are enabled for a flow, an unscoped object in a disabled or
unlisted parameter could reach the generic input merge. Arrays, scalars and
node-scoped objects already checked the node label and parameter permission.
The object branch now rejects the value before inspecting or merging its keys
unless that exact parameter is enabled for the node label.

The caller-level API-override switch remains unchanged. Enabled object merging,
node targeting, array de-duplication, scalar conversion, the separate variable
allowlist and the explicit analytics exception retain their behavior.

## Reproduction and validation

Run from `packages/server` after the repository pnpm install:

```sh
pnpm exec jest --selectProjects stubbed-orm --runInBand --runTestsByPath src/utils/index.override.test.ts
```

The test extracts and compiles the actual self-contained production declaration
with TypeScript and runs it in an isolated context to avoid unrelated startup
imports. It does not implement a substitute helper. The unchanged helper fails
four denial assertions and passes fifteen compatibility assertions; the guarded
helper passes all nineteen. Inputs and endpoints are synthetic.

Full repository CI remains a merge gate. A merged source fix is not a claim
that an existing container has been replaced. Runtime rollout requires its own
exact-image tests, recovery preparation and acceptance evidence.

## Security scope

This repair addresses a parameter permission bypass. It does not establish
external code execution, change filesystem access or remediate every parser and
dependency advisory. The legacy string FILE-STORAGE bypass and the separate
ungated flow-configuration spread described by upstream advisories are different
paths; neither is reintroduced by this change.
