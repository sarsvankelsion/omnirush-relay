#!/usr/bin/env node
import { main } from '../src/cli.js';
import { asRelayError } from '../src/errors.js';

main().catch((error) => {
  const relay = asRelayError(error);
  console.error(`\n  error: ${relay.message}\n`);
  process.exitCode = relay.status === 0 ? 1 : 1;
});
