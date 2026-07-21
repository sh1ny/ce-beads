---
title: "feat: Missing required field"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Missing required field

## Goal Capsule

- **Objective:** A unit missing the required `**Test scenarios:**` field.

---

## Product Contract

### Summary

Tests missing-required-field rejection.

### Requirements

- R1. All required fields present.

---

## Implementation Units

### U1. Unit missing test scenarios

- **Goal:** Omit the Test scenarios field.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u.ts`
- **Approach:** Omit a required field.
- **Patterns to follow:**
  - None.
- **Verification:** Rejected for missing field.
