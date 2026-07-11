export function cliReportsDisabled(output: string): boolean {
  return /^Command line interface is not enabled\.\s+Please turn it on in Settings\s*>\s*General\s*>\s*Advanced\.?$/iu.test(
    output.trim(),
  );
}

export function cliReportsVersion(output: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:\s+\(installer\s+\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\))?$/u.test(
    output.trim(),
  );
}
