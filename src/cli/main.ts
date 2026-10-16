#!/usr/bin/env bun
import { chromeSignIn } from '../signin/chrome';
import { disposeHttpClient } from '../x/http-client';
import { connectX } from '../x/session';
import { runCli } from './run';

const env = process.env;
const code = await runCli(
  process.argv.slice(2),
  { env, connect: connectX, signIn: chromeSignIn(env), now: () => Date.now() },
  { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
);
await disposeHttpClient();
process.exit(code);
