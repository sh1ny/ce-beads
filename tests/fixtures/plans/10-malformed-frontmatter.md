---
title: "feat: Malformed frontmatter"
this line has no colon and is invalid yaml
type: feat
date: 2026-07-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Malformed frontmatter

This fixture's frontmatter contains a line with no `key: value` structure,
which is invalid YAML for the flat-scalar contract. The parser must reject
this with FRONTMATTER_MALFORMED.

## Goal Capsule

- **Objective:** Be rejected for malformed frontmatter.

---

## Product Contract

### Summary

Malformed frontmatter fixture.

### Requirements

- R1. Rejected.

---

## Implementation Units

### U1. Unit

- **Goal:** Exist.
- **Requirements:** R1.
- **Dependencies:** —
- **Files:**
  - `src/u.ts`
- **Approach:** Present.
- **Patterns to follow:**
  - None.
- **Test scenarios:**
  - Rejected.
- **Verification:** Malformed.
