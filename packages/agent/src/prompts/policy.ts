/** The pull request rules bots read (code-and-repos skill, plan execution note, session brief). */
export function pullRequestNote(options: {
  draftPrs: boolean
  /** true/false: what this plan or session may do; undefined: the workspace rule (a plan may allow more). */
  mergeAllowed: boolean | undefined
  autoMergePrs: boolean
}): string {
  const draft = options.draftPrs
    ? '- Open pull requests as drafts (`gh pr create --draft`); the user marks them ready after reviewing.'
    : '- Open pull requests ready for review (not as drafts), unless the user asks for a draft.'
  const merge =
    options.mergeAllowed === true
      ? '- Merging is allowed here: once the work is done and its checks pass, merge the pull request (`gh pr merge`) and report it.'
      : options.mergeAllowed === false
        ? '- Do not merge the pull request (`gh pr merge`) nor push to the base branch: open it, report its link and let the user merge it.'
        : options.autoMergePrs
          ? '- You may merge your pull requests (`gh pr merge`) once their checks pass.'
          : '- Never merge pull requests (`gh pr merge`) nor push to the base branch, unless your approved plan or session brief allows it: open the PR, report its link and let the user merge it.'
  return `${draft}\n${merge}`
}
