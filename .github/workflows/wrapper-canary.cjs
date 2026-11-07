// Trusted controller for #138. Nothing from the candidate is checked out here.
const REPOSITORY = 'cgwalters-forge/actions';
const SCRATCH = { owner: 'cgwalters-forge-stage', repo: 'board-test' };
const DISPATCH = 'wrapper-canary-dispatch.yml';
const REVIEW = 'wrapper-canary-review.yml';
const DEADLINE_MS = 8 * 60_000;

exports.changesWrapper = files => files.some(file => [file.filename, file.previous_filename].some(path =>
  path && (/^\.github\/workflows\/(cgwalters-|wrapper-canary)/.test(path) ||
    /^(admit|deployment|tailscale|secure-host|sandbox-share)\//.test(path))));

exports.needsCanary = (pull, files) => !Number.isInteger(pull.changed_files) ||
  files.length !== pull.changed_files || exports.changesWrapper(files);

exports.problems = ({ run, jobs, workflow, job, sha }) => {
  const refs = (run.referenced_workflows ?? []).filter(ref => ref.path.startsWith(`${workflow}@`));
  const found = [];
  if (!refs.length || refs.some(ref => ref.sha !== sha)) found.push('wrapper did not resolve to the admitted head');
  if (run.status !== 'completed' || run.conclusion !== 'success') found.push('run did not succeed');
  // The shared agent is now itself a reusable workflow, hence two / agent parts.
  for (const name of [`${job} / agent / agent`, `${job} / check / check`]) {
    const matching = jobs.filter(each => each.name === name);
    if (matching.length !== 1 || matching[0].conclusion !== 'success') found.push(`${name} did not succeed`);
  }
  return found;
};

function number(name, value) {
  if (!/^[1-9][0-9]{0,8}$/.test(value ?? '')) throw new Error(`${name} must be a positive item number`);
  return Number(value);
}

exports.runCanary = async ({ github, context, core, env = process.env, now = Date.now,
  sleep = () => new Promise(resolve => setTimeout(resolve, 10_000)) }) => {
  const { PULL, SHA, ISSUE, SCRATCH_PULL } = env;
  if (`${context.repo.owner}/${context.repo.repo}` !== REPOSITORY || context.ref !== 'refs/heads/main') {
    throw new Error('Run the trusted canary controller on actions main');
  }
  const pull_number = number('pull', PULL);
  const issue = number('WRAPPER_CANARY_ISSUE', ISSUE);
  const scratch = number('WRAPPER_CANARY_PULL', SCRATCH_PULL);
  if (!/^[0-9a-f]{40}$/.test(SHA ?? '')) throw new Error('sha must be an exact lowercase commit ID');
  const getPull = async () => (await github.rest.pulls.get({ ...context.repo, pull_number })).data;
  const pull = await getPull();
  if (pull.state !== 'open' || pull.base.ref !== 'main' || pull.head.sha !== SHA) throw new Error('PR is no longer at the admitted head on main');
  const { data: branch } = await github.rest.git.getRef({ ...context.repo, ref: 'heads/wrapper-canary' });
  if (branch.object.sha !== SHA) throw new Error('Promote the reviewed head to wrapper-canary first');
  const { data: target } = await github.rest.pulls.get({ ...SCRATCH, pull_number: scratch });
  if (target.draft || target.merged || target.head.repo?.full_name !== `${SCRATCH.owner}/${SCRATCH.repo}`) {
    throw new Error('Use a non-draft, unmerged in-repository scratch PR');
  }
  const start = new Date(now()).toISOString();
  const deadline = now() + DEADLINE_MS;
  const children = [
    { repo: context.repo, workflow_id: DISPATCH, job: 'dispatch', wrapper: 'cgwalters-agentic-job.yml',
      matches: run => run.display_title === `wrapper canary dispatch ${SHA}` && run.event === 'workflow_dispatch' && run.head_sha === context.sha },
    { repo: SCRATCH, workflow_id: REVIEW, job: 'review', wrapper: 'cgwalters-review.yml',
      matches: run => run.event === 'pull_request_target' && (run.pull_requests ?? []).some(pr => pr.number === scratch && pr.head.sha === target.head.sha) },
  ];
  try {
    await github.rest.actions.createWorkflowDispatch({ ...context.repo, workflow_id: DISPATCH, ref: 'main', inputs: { sha: SHA, issue: String(issue) } });
    if (target.state === 'open') await github.rest.pulls.update({ ...SCRATCH, pull_number: scratch, state: 'closed' });
    await github.rest.pulls.update({ ...SCRATCH, pull_number: scratch, state: 'open' });
    while (children.some(child => child.run?.status !== 'completed')) {
      if (now() >= deadline) throw new Error('Wrapper canary exceeded its eight-minute session deadline');
      for (const child of children) {
        if (child.run) {
          ({ data: child.run } = await github.rest.actions.getWorkflowRun({ ...child.repo, run_id: child.run.id }));
        } else {
          const { data } = await github.rest.actions.listWorkflowRuns({ ...child.repo, workflow_id: child.workflow_id, created: `>=${start}`, per_page: 100 });
          const matches = data.workflow_runs.filter(child.matches);
          if (matches.length > 1 || data.total_count > 100) throw new Error('Ambiguous canary runs; retry after they finish');
          child.run = matches[0];
        }
      }
      if (children.some(child => child.run?.status !== 'completed')) await sleep();
    }
    for (const child of children) {
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...child.repo, run_id: child.run.id, filter: 'latest', per_page: 100 });
      const found = exports.problems({ run: child.run, jobs, workflow: `${REPOSITORY}/.github/workflows/${child.wrapper}`, job: child.job, sha: SHA });
      core.info(`${child.run.html_url}: ${found.join('; ') || 'agent and checked handback succeeded'}`);
      if (found.length) throw new Error(found.join('; '));
    }
    if ((await getPull()).head.sha !== SHA) throw new Error('PR head moved during the canary');
  } finally {
    // Also cancel on a failed sibling or an API error, not only timeout. A run
    // not yet discoverable must be cancelled manually (see the runbook).
    const cleanup = await Promise.allSettled(children.filter(child => child.run && child.run.status !== 'completed')
      .map(child => github.rest.actions.cancelWorkflowRun({ ...child.repo, run_id: child.run.id })));
    // Do not mask a timeout/API failure, or let one cancellation failure stop
    // cancellation of its sibling. A failed cleanup can never attest success.
    for (const result of cleanup) if (result.status === 'rejected') core.warning(`Cancel unfinished canary manually: ${result.reason}`);
  }
};

// The existing required ci job is the opt-in merge gate. Only successful
// controller runs from this exact base revision can attest this PR head.
exports.checkCanary = async ({ github, context, core, env = process.env }) => {
  if (env.REQUIRED !== 'true' || !context.payload.pull_request) return;
  const event = context.payload.pull_request;
  const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: event.number });
  if (pull.state !== 'open' || pull.head.sha !== event.head.sha || pull.base.ref !== 'main') {
    throw new Error('PR moved or closed; run ci on its current head');
  }
  const files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: pull.number, per_page: 100 });
  if (!exports.needsCanary(pull, files)) return;
  // A rerun retains its original event payload and checkout. Require a fresh
  // PR event after a base advance, rather than pretending the rerun tested it.
  if (pull.base.sha !== event.base.sha) throw new Error('Base advanced; update the PR branch to run ci and canary against the new base');
  const { data } = await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id: 'wrapper-canary.yml',
    branch: 'main', event: 'workflow_dispatch', status: 'success', per_page: 100 });
  const title = `wrapper canary ${pull.number} ${pull.head.sha}`;
  const run = data.workflow_runs.find(run => run.display_title === title && run.head_sha === pull.base.sha &&
    run.status === 'completed' && run.conclusion === 'success' && run.path === '.github/workflows/wrapper-canary.yml');
  if (!run) throw new Error('This head needs a successful wrapper canary on the current base; dispatch it, then rerun ci');
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'latest', per_page: 100 });
  if (jobs.filter(job => job.name === 'canary' && job.conclusion === 'success').length !== 1) throw new Error('Canary was skipped or did not succeed');
  core.info(`Wrapper canary: ${run.html_url}`);
};
