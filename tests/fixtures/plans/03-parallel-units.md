---
title: "feat: Parallel independent units"
type: feat
date: 2026-07-20
topic: ce-beads-fixture
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Parallel independent units

## Goal Capsule

- **Objective:** Two independent units with no dependencies, both ready in parallel.

---

## Product Contract

### Summary

A parallel-units plan.

### Requirements

- R1. Unit one.
- R2. Unit two.

---

## Implementation Units

### U1. Independent unit one

- **Goal:** Be ready without depending on anything.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/a.ts`
- **Approach:** Implement independently.
- **Patterns to follow:**
  - No deps.
- **Test scenarios:**
  - U1 is ready immediately.
- **Verification:** U1 parses.

### U2. Independent unit two

- **Goal:** Be ready without depending on anything.
- **Requirements:** R2.
- **Dependencies:** —
- **Files:**
  - `src/b.ts`
- **Approach:** Implement independently.
- **Patterns to follow:**
  - No deps.
- **Test scenarios:**
  - U2 is ready immediately.
- **Verification:** U2 parses.

---

## Verification Contract

| Gate | Command | Proves |
|---|---|---|
| Unit | `bun test` | Parallel readiness |

---

## Definition of Done

- Both units ready together.
