---
title: "feat: Dangling dependency"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Dangling dependency

## Goal Capsule

- **Objective:** A plan where U2 depends on U9, which does not exist.

---

## Product Contract

### Summary

Tests dangling dependency rejection.

### Requirements

- R1. Valid deps.

---

## Implementation Units

### U1. Root unit

- **Goal:** Exist.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u1.ts`
- **Approach:** Root.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Parses.
- **Verification:** Present.

### U2. Unit with dangling dep

- **Goal:** Depend on a non-existent unit.
- **Requirements:** R1.
- **Dependencies:** U9.
- **Files:**
  - `src/u2.ts`
- **Approach:** Dangling.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Rejected naming U9.
- **Verification:** Dangling detected.
