// Runs the `graph` command the way src/bin.ts does, without loading the rest of the CLI.
import { UsageError, errorMessage } from '../src/cli/util.ts';
import { main } from '../src/graph/cli.ts';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`graph: ${errorMessage(err)}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
