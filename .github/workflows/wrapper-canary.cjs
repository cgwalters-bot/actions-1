// The wrapper canary's decisions (README.md, "Wrapper canary"), for
// wrapper-canary.yml's and wrapper-canary-gate.yml's scripts and
// wrapper-canary.test.mjs.

// The files whose change a pull request must prove with a canary run. Not
// admit, deployment or tailscale: the wrappers call those at main, so no
// run before the merge can use a pull request's copy of them.
const WRAPPERS = ['.github/workflows/cgwalters-agentic-job.yml', '.github/workflows/cgwalters-review.yml'];

// The commit status the ruleset on main requires.
exports.STATUS_CONTEXT = 'wrapper-canary';

// Whether a pull request's files (the API's list) change a wrapper; a
// rename counts under either name.
exports.changesWrapper = files =>
  files.some(file => WRAPPERS.includes(file.filename) || WRAPPERS.includes(file.previous_filename));

// Whether PULL (the API's pull request) needs a canary run, from FILES, the
// API's list of its files: also when that list is short of its
// `changed_files`, as the API lists at most 3,000.
exports.needsCanary = (pull, files) => files.length < pull.changed_files || exports.changesWrapper(files);

// Why a run does not show that WORKFLOW (OWNER/REPO/.github/workflows/FILE)
// ran at SHA as job JOB and its agent handed back a result that check
// accepted; empty when it does. RUN is the API's run, with its
// `referenced_workflows`; JOBS are its jobs, named as GitHub names a called
// workflow's (`JOB / agent`, `JOB / check / check`).
exports.problems = ({ run, jobs, workflow, job, sha }) => {
  const called = (run.referenced_workflows ?? []).filter(ref => ref.path.startsWith(`${workflow}@`));
  if (!called.length) return [`run ${run.id} did not call ${workflow}`];
  const found = [];
  for (const ref of called) {
    if (ref.sha !== sha) found.push(`run ${run.id} called ${ref.path} at ${ref.sha}, not the pull request's head ${sha}`);
  }
  for (const [name, what] of [[`${job} / agent`, 'the agent session'], [`${job} / check / check`, 'the check of what it handed back']]) {
    const conclusion = jobs.find(each => each.name === name)?.conclusion ?? 'not run';
    if (conclusion !== 'success') found.push(`${what} (${name}) in run ${run.id}: ${conclusion}`);
  }
  return found;
};
