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

# Linear three-unit plan (revised: changed U2)

## Goal Capsule

- **Objective:** A revised plan where open U2's content has changed.

---

## Product Contract

### Summary

A linear plan with U2 content changed.

### Requirements

- R1. Unit one.
- R2. Unit two changed.
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

### U2. Second unit (content changed)

- **Goal:** Depend on U1 with revised content.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `src/u2.ts`
- **Approach:** Implement unit two with a changed approach and revised test scenarios.
- **Patterns to follow:**
  - Linear ordering.
  - Revised pattern.
- **Test scenarios:**
  - U2 becomes ready after U1 closes.
  - U2 content is detected as changed.
- **Verification:** U2 parses with dep U1 and changed content.

### U3. Third unit

- **Goal:** Depend on U2.
- **Requirements:** R3.
- **Dependencies:** U2.
- **Files:**
  - `src/u3.ts`
- **Approach:** Implement unit three depending on two.
- **Patterns to follow:**
  - Linear ordering.
- **Test scenarios:**
  - U3 becomes ready after U2 closes.
- **Verification:** U3 parses with dep U2.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Unit | `bun test` | Changed content |

---

## Definition of Done

- U2 content changed.
