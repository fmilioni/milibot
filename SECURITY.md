# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately through
[GitHub's private vulnerability reporting](../../security/advisories/new) (Security → Report a vulnerability).
Include what is affected, how to reproduce it and the impact you expect. You will get an answer as soon as
possible, and a fix is released before the details are made public.

## Supported versions

Only the latest release receives security fixes.

## Scope

Milibot runs a local daemon (loopback only, token-protected) and one QEMU virtual machine per workspace in
which AI bots execute commands. Reports about bots escaping the VM, reaching the host outside the documented
channels, reading secrets they should not see, or other local users reaching the daemon are especially
welcome. Behavior of the AI models themselves (e.g. a bot following a prompt injection inside its own VM) is
out of scope unless it crosses one of those boundaries.
