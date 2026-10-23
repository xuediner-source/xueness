/** Scoped CLI output routing; fullscreen presentation is provided by its owning plugin. */
type Output = { write(text: string): unknown; close?(): void };
let routed: Output | null = null;

export const cliErrorOutput: Output = { write(text) { return (routed ?? process.stderr).write(text); } };
export const out = (text = ""): void => { (routed ?? process.stdout).write(text + "\n"); };
export const err = (text = ""): void => { cliErrorOutput.write(text + "\n"); };

export function routeCliOutput(output: Output): () => void {
  const previous = routed;
  routed = output;
  return () => { routed = previous; };
}

/** Leave fullscreen before argparse reports an error on the ordinary terminal. */
export function endCliOutput(): void { routed?.close?.(); routed = null; }
