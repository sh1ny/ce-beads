---
title: "feat: Single unit with a failing verification command"
type: feat
date: 2026-07-21
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Single unit with failing verification

## Goal Capsule

- **Objective:** A single-unit plan whose verification command exits non-zero, for the `VERIFICATION_FAILED` → blocked path.
- **Stop conditions:** Worker "completes"; pre-merge verification fails; unit blocks.

---

## Product Contract

### Summary

One unit with a verification command that always fails.

### Requirements

- R1. The implementation exists.

---

## Implementation Units

### U1. Failing verification unit

- **Goal:** Implement a trivial file, but the verification command fails.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u1.ts`
- **Approach:** Create `src/u1.ts` exporting a constant. The verification command below will exit 1.
- **Patterns to follow:**
  - Minimal.
- **Test scenarios:**
  - U1 is claimed, worker completes, verification fails, unit blocks.
- **Verification:** The `false` command exits 1, failing verification.

---

## Verification Contract

| U-ID | Command | Proves |
|---|---|---|
| U1 | `false` | Implementation correctness (always fails) |

---

## Definition of Done

- U1 implementation present but verification fails → run blocks with `VERIFICATION_FAILED`.
