[日本語](backup-and-restore.ja.md)

# Backing Up and Restoring the DB

The conversation history is in `{ship directory}/data/bridge.db` (SQLite), one per ship.

## Backup

1. Stop the ship's server.
2. Copy `data/bridge.db` somewhere else (after a forced termination, copy all of `data/bridge.db*` together, as described in the note below).

   ```
   cp data/bridge.db /path/to/backup/bridge-$(date +%F).db
   ```

When you stop a ship with `Ctrl+C` (or `SIGTERM`, or "Stop" on the settings screen), it merges the write log (`bridge.db-wal`) into `bridge.db` before closing. In this case, **that one file is a complete backup** (`-wal` and `-shm` are not needed).

**After a forced termination (`kill -9`, a power cut, a crash), that is not necessarily so.** The part that was not merged remains in `bridge.db-wal`. In that case, copy **all of `data/bridge.db*` together**, not just `bridge.db` (or start the ship once more, stop it again with `Ctrl+C`, and then copy).

## Restore

1. Stop the ship's server.
2. Move the old files aside, including `-wal` and `-shm`, and put the backup in place (the old `-wal` belongs to the old `bridge.db`, so it must not be combined with the backup's `bridge.db`).

   ```
   mkdir data/old
   mv data/bridge.db* data/old/
   cp /path/to/backup/bridge-2026-01-01.db data/bridge.db
   ```

3. Start the server. If the backup is from an older version, it is automatically migrated to the latest version at startup.

## Automatic backup before a migration

When an update changes the structure of the database, a copy is automatically made at `data/bridge.db.bak-v<old version>` before rewriting. If a file with that name exists, a timestamp is appended (nothing is overwritten). Old ones are not deleted automatically.

- To go back to the previous version after an update, revert to the previous version of the program and put the `.bak-v*` in place as `bridge.db` (the restore steps above).
- **A DB of a newer version than this program is not modified at all, and startup fails with an error.** This is so that a DB created by a newer version is not broken by an older version of the program.

For details, see [Data model](../reference/data-model.md#migrations).
