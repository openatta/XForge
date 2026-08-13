export default {
  test: {
    /*
     * Heavy integration files (work-packages, audit, install, hook-cli, ...) drive many CLI
     * subprocesses per test; under the gate's parallel-worker load they run ~3x slower than in
     * isolation, so the previous 30s budget flaked on the longest chains (observed: an 11.5s
     * test timing out in the full suite). Passing tests never approach this bound — it only
     * decides how long a genuinely hung test burns before failing.
     */
    testTimeout: 60_000,
  },
};
