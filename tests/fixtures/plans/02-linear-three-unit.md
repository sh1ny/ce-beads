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

# Linear three-unit plan

## Goal Capsule

- **Objective:** A three-unit linear plan U1 -> U2 -> U3 for dependency testing.
- **Stop conditions:** Parses with dependency edges U2->U1, U3->U2.

---

## Product Contract

### Summary

A linear three-unit plan.

### Requirements

- R1. Unit one.
- R2. Unit two.
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

### U2. Second unit

- **Goal:** Depend on U1.
- **Requirements:** R2.
- **Dependencies:** U1.
- **Files:**
  - `src/u2.ts`
- **Approach:** Implement unit two depending on one.
- **Patterns to follow:**
  - Linear ordering.
- **Test scenarios:**
  - U2 becomes ready after U1 closes.
- **Verification:** U2 parses with dep U1.

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
| Unit | `bun test` | Linear deps |

---

## Definition of Done

- All three units parse with correct dependencies.
