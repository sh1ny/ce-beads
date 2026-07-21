---
title: "feat: Duplicate unit IDs"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Duplicate unit IDs

## Goal Capsule

- **Objective:** A plan with two U1 units, which must be rejected.

---

## Product Contract

### Summary

Tests duplicate U-ID rejection.

### Requirements

- R1. Unique IDs.

---

## Implementation Units

### U1. First occurrence

- **Goal:** Be the first U1.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/a.ts`
- **Approach:** First.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Rejected.
- **Verification:** Duplicate detected.

### U1. Duplicate occurrence

- **Goal:** Be the duplicate U1.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/b.ts`
- **Approach:** Duplicate.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Rejected.
- **Verification:** Duplicate detected.
