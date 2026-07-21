---
title: "feat: Linear three-unit plan"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Linear three-unit plan (revised: removed U2)

## Goal Capsule

- **Objective:** A revised plan where U2 has been removed.

---

## Product Contract

### Summary

A linear plan with U2 removed and U3 re-parented onto U1.

### Requirements

- R1. Unit one.
- R3. Unit three.

---

## Implementation Units

### U1. First unit

- **Goal:** Be the root of the chain.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u1.ts`
- **Approach:** Implement unit one.
- **Patterns to follow:**
  - Linear ordering.
- **Test scenarios:**
  - U1 is ready first.
- **Verification:** U1 parses.

### U3. Third unit (re-parented onto U1)

- **Goal:** Depend on U1 after U2 removal.
- **Requirements:** R3.
- **Dependencies:** U1.
- **Files:**
  - `src/u3.ts`
- **Approach:** Implement unit three now depending on one.
- **Patterns to follow:**
  - Linear ordering.
- **Test scenarios:**
  - U3 becomes ready after U1 closes.
- **Verification:** U3 parses with dep U1.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Unit | `bun test` | Removed unit |

---

## Definition of Done

- U2 removed.
