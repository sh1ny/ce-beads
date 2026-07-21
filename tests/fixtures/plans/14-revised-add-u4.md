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

# Linear three-unit plan (revised: added U4)

## Goal Capsule

- **Objective:** A revised plan that adds U4 depending on U3.

---

## Product Contract

### Summary

A linear plan with an added fourth unit.

### Requirements

- R1. Unit one.
- R2. Unit two.
- R3. Unit three.
- R4. Unit four.

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

### U4. Fourth unit (added)

- **Goal:** Depend on U3.
- **Requirements:** R4.
- **Dependencies:** U3.
- **Files:**
  - `src/u4.ts`
- **Approach:** Implement unit four depending on three.
- **Patterns to follow:**
  - Linear ordering.
- **Test scenarios:**
  - U4 becomes ready after U3 closes.
- **Verification:** U4 parses with dep U3.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Unit | `bun test` | Added unit |

---

## Definition of Done

- U4 added.
