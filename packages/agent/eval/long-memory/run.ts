/**
 * Long-memory eval: a long synthetic conversation with facts planted at the start, questions about
 * them at the end. Reports recall and cost per turn.
 *
 *   pnpm --filter @milibot/agent eval:long-memory                      # fake provider (deterministic)
 *   OPENROUTER_API_KEY=… EVAL_MODEL=anthropic/claude-haiku-4.5 pnpm --filter @milibot/agent eval:long-memory
 *   ANTHROPIC_API_KEY=… EVAL_MODEL=claude-haiku-4-5 pnpm --filter @milibot/agent eval:long-memory
 *
 * Options (env): EVAL_PROVIDER=fake|openrouter|anthropic (default: fake unless a key is set),
 * EVAL_FILLER=<exchanges> (default 80), EVAL_TAIL=<tail budget tokens> (default 4000),
 * EVAL_RETRIEVED=<retrieval budget tokens> (default 1500; 0 = off),
 * EVAL_SEED=<n>, EVAL_JSON=<path> (write the full report).
 */
import { writeFileSync } from 'node:fs'

import { type EvalOptions, runLongMemoryEval } from './eval'

const provider = (process.env.EVAL_PROVIDER ??
  (process.env.OPENROUTER_API_KEY
    ? 'openrouter'
    : process.env.ANTHROPIC_API_KEY
      ? 'anthropic'
      : 'fake')) as EvalOptions['provider']

runLongMemoryEval({
  provider,
  filler: Number(process.env.EVAL_FILLER ?? 80),
  tailBudget: Number(process.env.EVAL_TAIL ?? 4000),
  ...(process.env.EVAL_RETRIEVED ? { retrievedBudget: Number(process.env.EVAL_RETRIEVED) } : {}),
  seed: Number(process.env.EVAL_SEED ?? 7),
})
  .then((report) => {
    const { results: rows, ...summary } = report
    console.log(JSON.stringify(summary, null, 2))
    for (const r of rows)
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.question} → ${r.reply.replace(/\s+/g, ' ')}`)
    if (process.env.EVAL_JSON) writeFileSync(process.env.EVAL_JSON, JSON.stringify(report, null, 2))
  })
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
