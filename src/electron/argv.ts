/**
 * `argv` the way the code that reads `argv.slice(2)` expects it: the program, a script, then the arguments. A packaged app has no script, so its arguments
 * follow the program at once and the first of them would be dropped; a stand-in for the script is put in front of them.
 */
export function withScript(argv: string[], packaged: boolean, script: string): string[] {
  return packaged ? [argv[0], script, ...argv.slice(1)] : argv;
}
