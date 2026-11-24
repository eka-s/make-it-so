/**
 * A ship ID is the name of its directory under `ships/`: a letter or digit first, then letters, digits, `_` and `-`. Anything else (a path, a name that begins
 * with `-` and would be read as an option) is not a ship, so it never reaches the file system or a command line.
 */
export const SHIP_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isShipId(id: string): boolean {
  return SHIP_ID.test(id);
}
