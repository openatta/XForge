#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: 'ignore' });
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  process.stderr.write('Unable to configure the repository-local Git hook. Run this command inside a writable Git checkout.\n');
  process.exit(1);
}

process.stdout.write('Installed the privacy Git hooks from .githooks/.\n');
process.stdout.write('The hooks reject sensitive content, commit messages, and non-noreply identities without printing matched values.\n');
