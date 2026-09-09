---
name: mesh-delegate
description: Delegate work to other Rivet mesh nodes via den task handoff
tags: [rivetos, mesh, delegation, grokbot]
version: 0.1.0
---

# Mesh Task Delegation (Grok Bot)

Delegate long-running or specialized work to other nodes in the Rivet mesh.

## Usage

When a task requires resources or access beyond this Grok Bot node (compilation, 
heavy analysis, home server access), delegate via the existing den task queue 
rather than attempting direct execution or asking the user to switch contexts.

## Handoff Contract

Tasks delegated to the mesh follow the house den handoff protocol:
- Work description includes context and deliverables
- Target node selection based on capability roster
- Results return via the same session key

Do not inject mesh tasks directly into Grok Bot UI threads. Delegation is 
asynchronous and follows the established den control plane.

## Current State

Mesh delegation infrastructure is pending full rollout. This skill documents 
the intended contract. When active:
- Query available nodes via den roster
- Submit work with session context
- Poll for completion or await callback

Until mesh handoff is live, acknowledge delegation requests and guide the user 
to run the work on the appropriate system directly.
