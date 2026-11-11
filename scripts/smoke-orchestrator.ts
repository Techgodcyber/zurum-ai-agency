/**
 * End-to-end smoke test for the control-plane + Maestro orchestration loop.
 *
 * Proves:
 *   1. A build job runs through intake→build→qa, checkpointing each step, then
 *      PAUSES at the human-approval gate (no deploy yet).
 *   2. After approval it RESUMES from the checkpoint (skips completed steps) and
 *      completes the deploy step.
 *   3. The runaway sentinel KILLS a job that blows past its caps.
 *
 * Run: npm run smoke:orchestrator
 */
import { createJob, getJob } from "../src/db/jobs.js";
import { getQueue } from "../src/queue/index.js";
import { Maestro } from "../src/orchestrator/maestro.js";
import type { Step } from "../src/orchestrator/types.js";

function line(label: string) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 48 - label.length))}`);
}

async function main() {
  const maestro = new Maestro();
  maestro.start();
  const queue = getQueue();

  // 1) Submit a build and run until it pauses for approval.
  line("1. submit build → run to approval gate");
  const jobId = await maestro.submit({
    description: "a bakery website with online ordering and a gallery",
  });
  await queue.drain();

  let job = await getJob(jobId);
  console.log(`  state:          ${job?.state}`);
  console.log(`  completedSteps: ${job?.checkpoint.completedSteps.join(", ")}`);
  console.log(`  spec:           "${job?.checkpoint.data["spec"]}"`);
  console.log(`  previewUrl:     ${job?.checkpoint.data["previewUrl"]}`);
  console.log(`  cost so far:    $${job?.costUsd.toFixed(6)}`);
  console.log(
    `  ✓ expected awaiting_approval, no deploy yet: ${
      job?.state === "awaiting_approval" &&
      !job.checkpoint.completedSteps.includes("deploy")
        ? "PASS"
        : "FAIL"
    }`,
  );

  // 2) Approve → resumes from checkpoint and finishes.
  line("2. approve → resume from checkpoint → complete");
  await maestro.approve(jobId);
  await queue.drain();

  job = await getJob(jobId);
  console.log(`  state:          ${job?.state}`);
  console.log(`  completedSteps: ${job?.checkpoint.completedSteps.join(", ")}`);
  console.log(`  deployedUrl:    ${job?.checkpoint.data["deployedUrl"]}`);
  console.log(
    `  ✓ expected completed + deploy done: ${
      job?.state === "completed" &&
      job.checkpoint.completedSteps.includes("deploy")
        ? "PASS"
        : "FAIL"
    }`,
  );

  // 3) Runaway sentinel: caps.maxSteps = 2 against a 4-step pipeline.
  line("3. runaway sentinel kills over-cap job");
  const stub = (name: string): Step => ({
    name,
    run: async () => ({ [name]: true }),
  });
  const runaway = new Maestro({
    pipeline: [stub("a"), stub("b"), stub("c"), stub("d")],
    caps: { maxSteps: 2 },
  });
  const j2 = await createJob({ type: "build", input: {} });
  await runaway.runJob(j2.id); // direct call (bypasses shared queue)

  const job2 = await getJob(j2.id);
  console.log(`  state:  ${job2?.state}`);
  console.log(`  error:  ${job2?.error}`);
  console.log(
    `  ✓ expected failed via sentinel: ${
      job2?.state === "failed" && (job2.error ?? "").includes("sentinel")
        ? "PASS"
        : "FAIL"
    }`,
  );

  line("done");
  process.exit(0);
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
