---
title: "feat: Cyclic dependencies"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Cyclic dependencies

## Goal Capsule

- **Objective:** A plan with a dependency cycle U1 -> U2 -> U1.

---

## Product Contract

### Summary

Tests cycle rejection.

### Requirements

- R1. Acyclic.

---

## Implementation Units

### U1. First cyclic unit

- **Goal:** Depend on U2.
- **Requirements:** R1.
- **Dependencies:** U2.
- **Files:**
  - `src/u1.ts`
- **Approach:** Cycle.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Cycle reported.
- **Verification:** Cycle detected.

### U2. Second cyclic unit

- **Goal:** Depend on U1.
- **Requirements:** R1.
- **Dependencies:** U1.
- **Files:**
  - `src/u2.ts`
- **Approach:** Cycle.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Cycle reported.
- **Verification:** Cycle detected.
