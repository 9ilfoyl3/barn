# Barn Desktop Instructions

## Product North Star

Barn Desktop is a general-purpose personal local Agent for everyday office work. Many users will have no prior Agent experience, so product and engineering decisions should favor a simple, intuitive, safe experience over expert-only controls or assumptions about a specialist role.

- Keep product language role-neutral and understandable to a first-time user.
- Prefer completing the user's task through sensible defaults and guided flows over exposing internal Agent concepts.
- Treat local-first operation, user-owned credentials, and explicit confirmation for consequential actions as product requirements.
- Validate broad office workflows before adding narrow industry-specific surfaces.
- Do not introduce a hosted control plane or account requirement into the core product experience.

Before changing non-trivial architecture, model configuration, sandbox, session semantics, or security behavior, read [Agent Notes](.agents/notes/README.md).

- Record durable decision rationale in `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`.
- Keep notes current with the shipped implementation.
- Search for an existing note before adding a duplicate.
- Mechanical and local UI changes do not need an Agent Note.
