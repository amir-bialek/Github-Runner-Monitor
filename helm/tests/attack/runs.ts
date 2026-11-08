// Story 7.1: builds a Debug Job run the way the backend's startRun does, with
// the backend's own buildJob and buildSecret, so the attack test runs exactly
// what the backend would start. Runs under Node type stripping (no build, no
// dependencies: the adapter imports @kubernetes/client-node for types only).
//
//   node runs.ts job <runId> <imageTag>   < job.json   prints the Job
//   node runs.ts secret <runId> <jobUid>                prints the Secret
//
// Story 7.2 uses the same commands (agent-attack-test.sh) and changes the Job
// and the Secret with jq before creating them.
//
// job.json is the template read back from the installed debug-it-job-template
// ConfigMap. The Secret is owned by the Job (as startRun does) and holds
// known fake values derived from the run ID; attack-test.sh derives the same:
//   anthropic key  sk-ant-attack-test-<runId>
//   upload code    attack-upload-<runId>
//   result code    attack-result-<runId>
import { readFileSync } from 'node:fs';
import { buildJob, buildSecret, jobName, parseJobTemplate } from '../../../code/backend/src/adapters/kubernetes.ts';

const TIME_LIMIT_SECONDS = 900;
// The agent attack test (7.2) runs real Claude sessions and raises it with
// ATTACK_SPEND_LIMIT_USD; 7.1 never starts Claude.
const SPEND_LIMIT_USD = Number(process.env.ATTACK_SPEND_LIMIT_USD) > 0 ? Number(process.env.ATTACK_SPEND_LIMIT_USD) : 1;

function usage(): never {
  console.error('usage: node runs.ts job <runId> <imageTag> < job.json | node runs.ts secret <runId> <jobUid>');
  process.exit(2);
}

const [mode, runId, arg] = process.argv.slice(2);
if (!runId || !arg) usage();

if (mode === 'job') {
  const template = parseJobTemplate(readFileSync(0, 'utf8'));
  const job = buildJob(template, {
    runId,
    imageTag: arg,
    secretName: jobName(runId),
    timeLimitSeconds: TIME_LIMIT_SECONDS,
    deadlineAt: new Date(Date.now() + TIME_LIMIT_SECONDS * 1000),
    spendLimitUsd: SPEND_LIMIT_USD,
  });
  console.log(JSON.stringify(job, null, 2));
} else if (mode === 'secret') {
  const secret = buildSecret({
    runId,
    job: { name: jobName(runId), uid: arg },
    anthropicApiKey: `sk-ant-attack-test-${runId}`,
    uploadCode: `attack-upload-${runId}`,
    resultCode: `attack-result-${runId}`,
  });
  console.log(JSON.stringify(secret, null, 2));
} else {
  usage();
}
