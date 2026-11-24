[日本語](desktop-app.ja.md)

# Using the Desktop App

The desktop app opens a ship in a window of its own. The ship's screen is not served on a port, so nothing in a browser can reach it. (The bulletin-board MCP that crew members call still listens on `127.0.0.1`, on a port the OS picks at each start; it needs the secret every session is given.)

## What happens when you open it

- **There is exactly one ship:** it opens at once.
- **There are several ships, or none:** a list appears. Choose a ship and it opens in a window of its own (its own icon in the Dock); the list closes. The **Settings** button on the list opens the settings, where a ship is made.
- **A ship is open:** opening the same ship again brings its window to the front instead of starting a second one.
- **Closing a ship's window stops that ship.** Its crew sessions end with it.
- **Settings:** from the list, or from a ship's window with the menu item (`⌘,` on macOS). In the settings, the Ships tab has an **Open the ship** button instead of start and stop. Removing a ship that is open is refused.

Your files are where they always were (`~/.make-it-so`); the desktop app and the browser version read the same ships. **A ship can be open in only one of them at a time**: starting it in one while it runs in the other is refused with a message (close the window, or stop the browser version, first).

## Running it from the source

```
npm run build
npm run start:electron                 # the ship, the list, or the settings, as above
npm run start:electron -- --ship alpha # one ship
npm run start:electron -- --settings   # the settings
```

## Making the app

```
npm run pack   # release/mac-arm64/Make-It-So.app (not packed into an installer)
npm run dist   # release/Make-It-So-<version>-arm64.dmg
```

The app is **not signed**, so macOS may warn when it is opened from a downloaded file. Signing and notarizing it needs a Developer ID certificate, which is not set up here. Only macOS (Apple silicon) has been built and run so far.
