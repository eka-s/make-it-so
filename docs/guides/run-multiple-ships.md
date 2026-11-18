[日本語](run-multiple-ships.ja.md)

# Running Multiple Ships

One ship is one process. Each ship uses its own port, its own DB, and its own browser tab.

## Steps

1. Under `~/.make-it-so/ships/`, create a ship directory and place a `ship.yml` in it. Give each ship **a different `port`** (a duplicate is an error at startup).

   ```
   ~/.make-it-so/ships/
     alpha/ship.yml    # port: 3939
     beta/ship.yml     # port: 3940
   ```

2. Build only once.

   ```
   npm run build
   ```

3. For each ship, use a separate terminal and start it with `--ship`.

   ```
   npm start -- --ship alpha
   npm start -- --ship beta
   ```

4. Open each port's page in a separate tab.

## Notes

- If there are several ships and you do not pass `--ship`, it lists the candidates and fails with an error.
- Ships do not share DBs, conversations, or missions with each other.
- You cannot view multiple ships together on a single screen.
- The same roster member can be assigned to multiple ships.
