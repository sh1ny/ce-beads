---
title: "feat: Two-unit plan where U2 imports U1's implementation"
type: feat
date: 2026-07-21
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Two-unit plan where U2 imports U1's implementation

## Goal Capsule

- **Objective:** A two-unit plan where U2 imports a symbol from U1's file, to exercise the worker-base-sha freshness invariant (P0-1).
- **Stop conditions:** U1 merged first; U2's worktree forks from the integration HEAD *after* U1 was merged, so U2's worktree contains U1's implementation file.

---

## Product Contract

### Summary

U1 creates a module exporting a constant; U2 imports and re-exports it.

### Requirements

- R1. U1 exports a constant.
- R2. U2 imports U1's constant and re-exports it.

---

## Implementation Units

### U1. Root module

- **Goal:** Create `src/u1.ts` exporting `ANSWER = 42`.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u1.ts`
- **Approach:** Export a numeric constant.
- **Patterns to follow:**
  - Minimal module.
- **Test scenarios:**
  - U1 is ready first; after close, U2 becomes ready.
- **Verification:** `src/u1.ts` exports `ANSWER`.

### U2. Dependent module

- **Goal:** Create `src/u2.ts` that imports `ANSWER` from `./u1.ts` and re-exports it.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `src/u2.ts`
- **Approach:** `import { ANSWER } from "./u1.ts"; export { ANSWER };`
- **Patterns to follow:**
  - ES module import.
- **Test scenarios:**
  - U2's worktree (forked from integration HEAD after U1 merged) contains `src/u1.ts`; the import resolves.
- **Verification:** `src/u2.ts` re-exports `ANSWER` from `src/u1.ts`.

---

## Verification Contract

| U-ID | Command | Proves |
|---|---|---|
| U1 | `test -f src/u1.ts` | U1 module exists |
| U2 | `grep -q ANSWER src/u2.ts` | U2 imports U1's symbol |

---

## Definition of Done

- Both units implemented; U2's worker_base_sha points to a commit that already contains U1's file.
