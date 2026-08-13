export default {
  test: {
    /*
     * The slowest tests spawn several real child processes (Gate/verify commands, `xforge` CLI
     * invocations) per test. 30s was borderline even on Node 24; on ubuntu-latest/Node 20 in CI
     * specifically (not Node 24, same OS, same tests), several of these tests reproducibly cross
     * 30s and get killed mid-run rather than genuinely hanging. Not a fix for a real hang — a
     * caching bug or infinite loop would still trip this ceiling, just later.
     */
    testTimeout: 60_000,
  },
};
