export function cliReportsDisabled(output: string): boolean {
  return /^Command line interface is not enabled\.\s+Please turn it on in Settings\s*>\s*General\s*>\s*Advanced\.?$/iu.test(
    output.trim(),
  );
}
