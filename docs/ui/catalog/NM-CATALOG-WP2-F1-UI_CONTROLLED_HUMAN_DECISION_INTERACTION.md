# NM-CATALOG-WP2-F1 UI Controlled Human Decision Interaction

Status: Draft v1
Domain: UI / Catalog
Phase: Human Review Workspace
Work Package: NM-CATALOG-WP2-F1 - Controlled Human Decision Interaction

## Purpose

This UI surface lets an authorized reviewer record a deliberate decision on a Catalog Observation review item.

The UI records human judgement only.

It does not apply Product values.
It does not expose Product apply controls.
It does not create a separate decision truth outside the controlled command boundary.

## Core UX Boundary

The existing review workspace remains the entry point.

The controlled decision interaction is a child workflow of the review item detail surface.

The user sees:

- current recommendation and current decision state
- apply eligibility as informational context
- a deliberate decision action
- a reversal action for the current decision
- a short audit trail for the currently loaded item

The user does not see:

- apply buttons
- mutation mechanics
- database concepts
- RPC names
- transaction details
- internal retry tokens

## Supported Decisions

The UI exposes only the controlled decision types:

- Accept recommendation
- Reject recommendation
- Defer
- Request more evidence

The UI also supports reversing the current decision with a controlled reason code.

## Confirmation Model

Every decision action opens a confirmation modal.

The modal must show:

- review item identity
- current recommendation
- current decision state
- apply eligibility context
- reason code selection
- reviewer note

The modal must make it clear that the action records a human decision only.

## State Visibility

Visible states should remain business-oriented:

- current
- stale
- reversed
- superseded
- invalidated
- requires re-review

The UI may expose apply eligibility as read-only context, but it must not open apply controls.

## Context Preservation

The review workspace must preserve:

- selected item
- URL-backed filters
- scroll/list context where already implemented
- focus return from the detail panel

## Governance

This UI follows the controlled human decision boundary only.

It is intentionally separate from any later Product apply workflow.
