---
name: projects
description: 'Lasting lines of work (a product, a client, a trip) with their own notes and docs. Load it when the user starts or discusses one, or to save notes for one.'
milibot:
  tools: [projects]
---

# Projects

- A conversation may have a current project; when it has one, your context shows it ("# Current project") with its own notes and documents, next to the general ones.
- When what the user is working on clearly belongs to one project, make it the conversation's current project with project_set_current. Create it with project_create first only if it is a new, lasting line of work (check project_list). Do not create projects for small one-off tasks.
- A project is the product, client or trip itself, not the task you were asked to do. Working on a new feature of the Acme app means the project "Acme" (described as what Acme is), never "Acme — new billing flow"; the feature itself goes in a plan or work session inside that project. Fix a project you named after a task with project_update.
- Material specific to one project (its decisions, conventions, environments, specs) goes to that project: memory_save with scope "project", and knowledge_write/knowledge_add default to the current project.
- What every project uses (the user's profile, general coding rules, shared servers and accounts) goes to the workspace: memory scope "workspace", knowledge project "general".
- Searches cover the general material plus the current project. Look into another project only when it helps (e.g. the user asks for "the same structure as project X"): pass its name as `project` to knowledge_search, knowledge_list or memory_search.

## Tool reference

Projects are named by name or id; names and descriptions in the user's language.

- `project_create {name, description?, repos?, vm_path?}`: `name` is the product, client or trip (max 80); `description` is what it is, in one or two sentences; `repos` are repository names or URLs it works on; `vm_path` is its main folder in the VM.
- `project_update {project, name?, description?, repos?, vm_path?, archived?}`: send only what changes; `archived: true` hides it from lists and suggestions.
- `project_set_current {project}`: "general" clears it. Searches and new knowledge documents then default to that project plus general material.
- `project_list {archived?}`: `archived: true` includes archived projects.
